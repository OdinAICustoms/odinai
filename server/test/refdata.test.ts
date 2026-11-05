import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { decimal, dateOrNull, displayCode, normCode, padCode, validateMapping } from '../src/refdata/parse.js';
import { decodeEntities, flatten, levelOf } from '../src/refdata/tariffstruct.js';
import { documentFor, rateUnit } from '../src/refdata/datasets.js';
import { runAll, runById, status } from '../src/refdata/runner.js';
import * as L from '../src/refdata/lookup.js';
import type { Fetchers } from '../src/refdata/fetch.js';
import { client, freshDb, PW } from './helpers.js';

/* Small payloads in the exact shapes data.toll.no publishes, each with the trap it is known for. */
const STRUCT = { avsnitt: [{ type: 'avsnitt', id: 'IV', beskrivelse: 'Næringsmidler', kapitler: [
  { type: 'kapittel', id: '21', beskrivelse: 'Forskjellige næringsmidler', inndelinger: [
    { type: 'posisjon', id: '2103', beskrivelse: 'Sauser', inndelinger: [
      { type: 'vare', id: '21039091', hsNummer: '210390', vareslag: 'flytende &#34;mango chutney&#34;', blv: false },
      { type: 'vare', id: '21039099', hsNummer: '210390', vareslag: 'ellers', blv: true, henvisninger: [{ type: 'x', id: '99999999' }] }] }] },
  { type: 'kapittel', id: '04', beskrivelse: 'Melk', inndelinger: [{ type: 'vare', id: '04032040', vareslag: 'yoghurt' }] }] }] };
const VARENUMMER = { varenummer: [
  { id: '21039091', enhet: '', fomdato: '2022-01-01', tomdato: '' },
  { id: '21039099', enhet: 'STK', enhetBeskrivelse: 'stykk', fomdato: '2022-01-01', tomdato: '' },
  { id: '04032040', fomdato: '2022-01-01', tomdato: '' }] };
const TL1 = { varer: [{ id: '04032040', avtalesatser: [
  { landgruppe: 'TAL', sats: [{ satsVerdi: '24,67', satsEnhet: 'K', satsEnhetBeskrivelse: 'kr per kg', fomdato: '2026-01-01', tomdato: '' }] },
  { landgruppe: 'TALL', sats: [{ satsVerdi: '23,99', satsEnhet: 'K', satsEnhetBeskrivelse: 'kr per kg', fomdato: '2026-01-01', tomdato: '' }] }] },
  { id: '21039099', avtalesatser: [{ landgruppe: 'TALL', sats: [{ satsVerdi: '0', satsEnhet: 'P', fomdato: '2026-01-01', tomdato: '' }] }] }] };
const RT = { varer: [{ id: '21039099', avtalesatser: [
  { landgruppe: 'TALL', sats: [{ satsVerdi: '4,70', satsEnhet: 'K', satsEnhetBeskrivelse: 'kr per kg', fomdato: '2026-01-01', tomdato: '' }] },
  { landgruppe: 'TOES', sats: [{ satsVerdi: '3,25', satsEnhet: 'K', satsEnhetBeskrivelse: 'kr per kg', fomdato: '2026-01-01', tomdato: '' }] }] }] };
const GROUPS = { landgrupper: [{ landgruppekode: 'TALL', landgruppenavn: 'Alle land' }, { landgruppekode: 'TAL', landgruppenavn: 'Albania' }, { landgruppekode: 'toes', landgruppenavn: 'EØS' }] };
const MEMBERS = { medlemsland: [
  { landkode: 'GB', landnavn: 'Storbritannia', landgrupper: [{ landgruppekode: 'TOES', fomdato: '1994-01-01', tomdato: '2020-12-31' }, { landgruppekode: 'TALL', fomdato: '1994-01-01', tomdato: '' }] },
  { landkode: 'DE', landnavn: 'Tyskland', landgrupper: [{ landgruppekode: 'TOES', fomdato: '1994-01-01', tomdato: '' }, { landgruppekode: 'TALL', fomdato: '1994-01-01', tomdato: '' }] },
  { landkode: 'AL', landnavn: 'Albania', landgrupper: [{ landgruppekode: 'TAL', fomdato: '2010-01-01', tomdato: '' }] }] };
const RESTR = { varer: [{ id: '04032040', restriksjoner: [
  { landgruppe: 'RALL', gjelder: 'opprinnelsesland', restriksjontype: 'VT', restriksjonsgruppe: '100', restriksjonsgruppebeskrivelse: 'Tillatelse Mattilsynet', fomdato: '2020-01-01', tomdato: '' },
  { landgruppe: 'RALL', gjelder: 'avsenderland', restriksjontype: 'V5', restriksjonsgruppe: '200', restriksjonsgruppebeskrivelse: 'Varsel Mattilsynet (CHED)', fomdato: '2020-01-01', tomdato: '' }] }] };
const ERRORS = { feilmelding: [{ meldingNummer: '9017', meldingTekst: 'Deklarasjonsdato er eldre enn 90 dager' }, { meldingNummer: '1234', meldingTekst: 'Annen feil' }] };
const FX = { omregningskurser: [
  { valutakode: 'EUR', valutabeskrivelse: 'Euro', valutakurs: '11,642', omregningsenhet: 1, fomdato: '2026-11-01', tomdato: '2026-11-30' },
  { valutakode: 'JPY', valutabeskrivelse: 'Japanske yen', valutakurs: '7,231', omregningsenhet: 100, fomdato: '2026-11-01', tomdato: '' },
  { valutakode: 'KRW', valutabeskrivelse: 'Koreanske won', valutakurs: '6,031', omregningsenhet: 100, fomdato: '2026-11-01', tomdato: '' }] };
const POSTAL = ['0150\tOSLO\t0301\tOSLO\tG', '5003\tBERGEN\t4601\tBERGEN\tG', 'xx\tbad line'].concat(
  Array.from({ length: 1200 }, (_, i) => `${String(6000 + i).padStart(4, '0')}\tSTED ${i}\t1500\tKOMMUNE\tG`)).join('\r\n');

const OFFICES = { ekspedisjonsenheter: [
  { ekspedisjonsenhetskode: '300101', ekspedisjonsenhetnavn: 'Ereg innførselsdeklarasjon', fagomraade: '30 - Egenregistrering', retning: 'Innførsel', fomdato: '2024-10-19', tomdato: '' },
  { ekspedisjonsenhetskode: '300102', ekspedisjonsenhetnavn: 'Ereg utførselsdeklarasjon', retning: 'Utførsel', fomdato: '2024-10-19', tomdato: '' },
  { ekspedisjonsenhetskode: '010390', ekspedisjonsenhetnavn: 'UTGÅENDE', retning: '', fomdato: '1990-01-01', tomdato: '2020-12-31' },
  { ekspedisjonsenhetskode: 'x', ekspedisjonsenhetnavn: 'bad' }] };
const PROCEDURES = { prosedyre: [{ prosedyrekode: '4000', prosedyrekodebeskrivelse: 'Fri disponering', fomdato: '2023-01-01', tomdato: '' },
  { prosedyrekode: '5000', prosedyrekodebeskrivelse: 'Midlertidig innførsel', fomdato: '2023-01-01', tomdato: '' }] };
const IMPORT_REFS = { referanser: [{ kode: 'DEL', beskrivelse: 'Delsending', fomdato: '2020-01-04', tomdato: '' }, { kode: 'txt', beskrivelse: 'Fritekst' }] };
const QUOTAS = { tollkvoter: [{ dokumentnummer: 'T010126B', landgruppekode: 'TEF', maksMengde: '2000000', avskrevetMengde: '0', mengdeenhet: 'V',
  varenumre: ['06021021', '6021024'], fomdato: '2026-04-01', tomdato: '2026-12-31' }] };
const CODE_VALIDITY = { vare: [] };
const LEVIES = { varer: [{ id: '17011490', avgiftsatser: [{ landgruppe: 'ALLE', avgiftstyper: [
  { avgiftstype: 'MV', avgiftstypebeskrivelse: 'Merverdiavgift', avgiftsgrupper: [{ avgiftsgruppe: '2', avgiftsgruppebeskrivelse: 'Lav sats', sats: '15', enhet: 'P', fomdato: '2015-01-01', tomdato: '' }] },
  { avgiftstype: 'su', avgiftstypebeskrivelse: 'Sukkeravgift', avgiftsgrupper: [{ avgiftsgruppe: '100', sats: '213,07', oresats: 'true', enhet: 'KGM', enhetbeskrivelse: 'Kilogram', fomdato: '2026-01-01', tomdato: '' }] }] }] }] };
const ADD_DUTY = { varer: [{ id: '76011000', avtalesatser: [{ landgruppe: 'TRB', sats: [{ satsVerdi: '50', satsEnhet: 'P', satsEnhetBeskrivelse: 'Prosent', fomdato: '2026-07-01', tomdato: '' }] }] }] };

const payloads: Record<string, unknown> = { tolltariffstruktur: STRUCT, varenummer: VARENUMMER, tollavgiftssats: TL1, raavaretollavgiftssats: RT,
  landgruppe: GROUPS, medlemsland: MEMBERS, innfoerselsrestriksjon: RESTR, feilmelding: ERRORS, valutakurs: FX,
  ekspedisjonsenhet: OFFICES, prosedyrekode: PROCEDURES, innfoerselsreferanse: IMPORT_REFS, tollkvote: QUOTAS, datogyldighetforvare: CODE_VALIDITY,
  innfoerselsavgift: LEVIES, tilleggstollavgiftssats: ADD_DUTY };
const fake = (over: Record<string, unknown> = {}): Fetchers => ({
  ckanDataset: async id => { const p = { ...payloads, ...over }[id]; if (!p) throw new Error(`no fixture ${id}`); return { data: p, url: `fixture:${id}` }; },
  textFile: async () => ({ text: POSTAL, url: 'fixture:postnummer' })
});

beforeAll(freshDb);
afterAll(() => pool.end());

describe('parsing rules learned from the live data', () => {
  it('codes in any form become one key', () => {
    expect(normCode('2103 90 99')).toBe('21039099');
    expect(normCode('21.03.9099')).toBe('21039099');
    expect(padCode('11')).toBe('00000011');
    expect(displayCode('21039099')).toBe('2103 90 99');
  });
  it('decimal comma is kept exact; empty is absent, not zero', () => {
    expect(decimal('24,67')).toBe('24.67');
    expect(decimal('1 234,50')).toBe('1234.50');
    expect(decimal('')).toBeNull();
    expect(decimal('n/a')).toBeNull();
  });
  it('an empty end date means open-ended', () => {
    expect(dateOrNull('')).toBeNull();
    expect(dateOrNull('2026-01-31T00:00:00')).toBe('2026-01-31');
  });
  it('rate unit and implied documents', () => {
    expect(rateUnit('K', 'kr per kg')).toBe('SPECIFIC');
    expect(rateUnit('P', '')).toBe('PERCENT');
    expect(documentFor('VT', 'Tillatelse Mattilsynet')).toBeNull();      // permit alone is not CHED
    expect(documentFor('V5', 'Varsel Mattilsynet (CHED)')).toBe('CHED');
  });
  it('tariff structure: entities decoded, references are not children, levels', () => {
    expect(decodeEntities('flytende &#34;mango chutney&#34;')).toBe('flytende "mango chutney"');
    const nodes = flatten(STRUCT.avsnitt);
    expect(nodes.some(n => n.digits === '99999999')).toBe(false);
    expect(nodes.find(n => n.digits === '21039099')!.pathText).toBe('Forskjellige næringsmidler > Sauser > ellers');
    expect(levelOf('posisjon', '2103')).toBe('Heading');
  });
  it('a mapping that does not match the source fails loudly', () => {
    expect(() => validateMapping([{ foo: 1 }], { code: ['id'] }, ['code'])).toThrow(/Feltkoblingen feilet.*foo/);
    expect(() => validateMapping([], { code: ['id'] }, ['code'])).toThrow(/ingen poster/);
  });
});

describe('loading and looking up', () => {
  it('loads every dataset and records each run', async () => {
    const out = await runAll({ fetchers: fake() });
    expect(out.map(o => `${o.dataset}:${o.status}`)).toEqual(['tolltariff:OK', 'tollsatser:OK', 'rt100-satser:OK', 'landgrupper:OK',
      'restriksjoner:OK', 'feilmeldinger:OK', 'valutakurser:OK', 'postnummer:OK',
      'tollsteder:OK', 'prosedyrer:OK', 'referansekoder:OK', 'tollkvoter:OK', 'datogyldighet:OK', 'avgifter:OK', 'tilleggstoll:OK']);
    const st = await status();
    expect(st.every(s => s.last?.status === 'OK' && s.lastOkAt)).toBe(true);
  });
  it('tariff: wording joined from the structure, units from varenummer, hierarchy kept', async () => {
    const t = await L.tariffCode('2103 90 99', '2026-11-04');
    expect(t!.text).toBe('ellers');
    expect(t!.supp_unit).toBe('STK');
    expect(t!.ancestors.map((a: any) => a.code)).toEqual(['21', '2103']);
    expect((await L.tariffCode('21039091'))!.text).toBe('flytende "mango chutney"');
    expect((await L.searchTariff('2103')).length).toBeGreaterThanOrEqual(3);
    expect((await L.searchTariff('chutney'))[0].code).toBe('21039091');
  });
  it('rates: TAL and TALL stay different, decimals exact, RT100 flagged', async () => {
    const y = await L.tariffCode('04032040', '2026-11-04');
    const r = Object.fromEntries(y!.rates.map((x: any) => [x.landgruppe, x.rate_value]));
    expect(r).toEqual({ TAL: '24.67', TALL: '23.99' });
    const s = await L.tariffCode('21039099', '2026-11-04');
    expect(s!.rtRequired).toBe(true);
    expect(s!.rates.filter((x: any) => x.duty_code === 'RT100').map((x: any) => x.rate_value)).toEqual(['4.70', '3.25']);
    expect((await L.tariffCode('21039099', '2025-06-01'))!.rates).toHaveLength(0);   // not in force yet
  });
  it('country groups follow the date (Brexit) and are matched exactly', async () => {
    expect(await L.groupsOf('GB', '2020-06-01')).toEqual(['TALL', 'TOES']);
    expect(await L.groupsOf('GB', '2026-11-04')).toEqual(['TALL']);
    expect(await L.groupsOf('AL', '2026-11-04')).toEqual(['TAL']);
    expect((await pool.query("SELECT code FROM landgruppe WHERE code = 'TOES'")).rowCount).toBe(1);   // "toes" upper-cased
  });
  it('restrictions keep dispatch vs origin, and CHED only when the text says so', async () => {
    const t = await L.tariffCode('04032040', '2026-11-04');
    expect(t!.restrictions.map((x: any) => [x.restriction_code, x.applies_to, x.document_code, x.authority])).toEqual([
      ['VT', 'opprinnelsesland', null, 'Mattilsynet'], ['V5', 'avsenderland', 'CHED', 'Mattilsynet']]);
  });
  it('FX: a per-100 quote is divided; periods follow the date', async () => {
    expect((await L.fxRate('JPY', '2026-11-04'))!.rate).toBe('0.07231');
    expect((await L.fxRate('KRW', '2026-11-04'))!.rate).toBe('0.06031');      // exact, not 0.060309999999999996
    expect((await L.fxRate('EUR', '2026-11-04'))!.rate).toBe('11.642');
    expect(await L.fxRate('EUR', '2026-12-05')).toBeNull();
    expect((await L.fxRate('NOK'))!.rate).toBe('1');
  });
  it('TVINN error codes carry the box to correct', async () => {
    expect((await L.errorText('9017'))!.box).toBe('f54');
    expect((await L.errorText('1234'))!.box).toBeNull();
  });
  it('declaration code lists: offices by direction and date, procedures, quotas padded, an empty list is fine', async () => {
    expect((await L.offices('IMPORT', '2026-11-04')).map((o: any) => o.code)).toEqual(['300101']);   // export-only and ended left out
    expect((await L.offices(undefined, '2026-11-04')).map((o: any) => o.code)).toEqual(['300101', '300102']);
    expect((await L.office('300 101'))!.direction).toBe('Innførsel');
    expect((await L.procedures()).map((p: any) => p.code)).toEqual(['4000', '5000']);
    expect((await L.importRefs()).map((p: any) => p.code)).toEqual(['DEL', 'TXT']);
    expect((await L.quota('T010126B'))!.codes).toEqual(['06021021', '06021024']);
    expect(await L.codeValidity('06021021')).toEqual([]);
  });
  it('box 47 levies: a rate in øre is divided by 100, types upper-cased; additional duty per country group', async () => {
    const lv = (await pool.query(`SELECT levy_type, levy_group, rate, unit FROM ref_import_levy WHERE code = '17011490' ORDER BY levy_type`)).rows;
    expect(lv).toEqual([{ levy_type: 'MV', levy_group: 2, rate: '15', unit: 'P' }, { levy_type: 'SU', levy_group: 100, rate: '2.1307', unit: 'KGM' }]);
    expect((await pool.query(`SELECT landgruppe, rate, unit, valid_from FROM ref_additional_duty`)).rows).toEqual([{ landgruppe: 'TRB', rate: '50', unit: 'P', valid_from: '2026-07-01' }]);
  });
  it('postal codes: bad lines skipped, search by number and name', async () => {
    expect((await L.postalSearch('015'))[0].poststed).toBe('OSLO');
    expect((await L.postalSearch('berg'))[0].postnr).toBe('5003');
  });
});

describe('safety of a refresh', () => {
  it('a source with a renamed field fails and keeps the old data', async () => {
    const before = (await pool.query('SELECT COUNT(*) n FROM tvinn_error_code')).rows[0].n;
    const out = await runById('feilmeldinger', { fetchers: fake({ feilmelding: { feilmelding: [{ nummer: '1', tekst: 'x' }] } }) });
    expect(out.status).toBe('FAILED');
    expect(out.message).toMatch(/Feltkoblingen feilet/);
    expect((await pool.query('SELECT COUNT(*) n FROM tvinn_error_code')).rows[0].n).toBe(before);
  });
  it('a source far smaller than the data held is refused (half-published dataset)', async () => {
    await runById('postnummer', { fetchers: fake() });
    const small = Array.from({ length: 1001 }, (_, i) => `${String(1000 + i)}\tA\t1\tB\tG`).join('\n');
    const many = Array.from({ length: 3000 }, (_, i) => `${String(1000 + i)}\tSTED\t1\tB\tG`).join('\n');
    await runById('postnummer', { fetchers: { ...fake(), textFile: async () => ({ text: many, url: 'x' }) } });
    const out = await runById('postnummer', { fetchers: { ...fake(), textFile: async () => ({ text: small, url: 'x' }) } });
    expect(out.status).toBe('REFUSED');
    expect((await pool.query('SELECT COUNT(*) n FROM postnummer')).rows[0].n).toBe(3000);
  });
  it('a network failure is recorded and the run of the others continues', async () => {
    const broken: Fetchers = { ...fake(), ckanDataset: async id => { if (id === 'feilmelding') throw new Error('Kan ikke nå data.toll.no'); return fake().ckanDataset(id); } };
    const out = await runAll({ fetchers: broken });
    expect(out.find(o => o.dataset === 'feilmeldinger')!.status).toBe('FAILED');
    // Postal codes are refused here (the previous test left 3,000 rows); the rest load normally.
    expect(out.filter(o => o.dataset !== 'feilmeldinger' && o.dataset !== 'postnummer').every(o => o.status === 'OK')).toBe(true);
    expect(out.find(o => o.dataset === 'postnummer')!.status).toBe('REFUSED');
  });
});

describe('API', () => {
  it('only an administrator may start a refresh; everyone signed in may read', async () => {
    const admin = client();
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    const st = await admin.get('/refdata/status');
    expect(st.status).toBe(200);
    expect(st.body).toHaveLength(15);
    expect((await admin.get('/refdata/offices?direction=IMPORT&date=2026-11-04')).body.map((o: any) => o.code)).toEqual(['300101']);
    expect((await admin.get('/refdata/tariff/21039099?date=2026-11-04')).body.rtRequired).toBe(true);
    expect((await admin.get('/refdata/tariff/99999999')).status).toBe(404);
    expect((await admin.get('/refdata/fx/JPY?date=2026-11-04')).body.rate).toBe('0.07231');
    const u = await admin.post('/admin/users', { name: 'Sara Spesialist', email: 'sara@odin.test', roles: ['specialist'] });
    const sara = client();
    await sara.post('/auth/login', { email: 'sara@odin.test', password: u.body.temporaryPassword });
    await sara.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    expect((await sara.get('/refdata/tariff?q=chutney')).body[0].code).toBe('21039091');
    expect((await sara.post('/refdata/refresh', {})).status).toBe(403);
  });
});
