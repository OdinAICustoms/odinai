import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { runById } from '../src/refdata/runner.js';
import { validContainerNo } from '../src/declarations/export.js';
import { client, freshDb, PW } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const rules = (b: any) => (b.issues as any[]).map(i => i.rule);

beforeAll(async () => {
  await freshDb();
  await pool.query(`INSERT INTO tariff (code, display, level, text) SELECT lpad(g::text, 8, '0'), lpad(g::text, 8, '0'), 'Code', 'test' FROM generate_series(10000000, 10001100) g`);
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('03021400', '0302 14 00', 'Code', 'laks'), ('87032310', '8703 23 10', 'Code', 'personbil')`);
  await pool.query(`INSERT INTO ref_export_levy (code, levy_type, levy_group, rate, unit, group_text) VALUES ('03021400', 'FA', 1, 0.25, 'P', 'Laks'), ('03021400', 'FA', 2, 0.15, 'P', 'Ørret')`);
  await pool.query(`INSERT INTO ref_export_restriction (code, rtype, rtype_text) VALUES ('87032310', 'M4', 'Understellsnummer'), ('87032310', 'U2', 'Avfall'), ('03021400', 'FD', 'Fangstdokument')`);
  await pool.query(`INSERT INTO ref_export_ref (code, text) VALUES ('UND', 'Unntak'), ('FD', 'Fangst'), ('SER', 'Opprinnelse'), ('DOK', 'Ref')`);
  await pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro'), ('SEK', 'Svenske kroner')`);
  await pool.query(`INSERT INTO fx_rate (currency, valid_from, rate, quoted) VALUES ('EUR', '2020-01-01', 11, 11)`);
  expect((await runById('utpasseringssteder')).status).toBe('OK');   // from server/reference/exit-offices.json
});
afterAll(() => pool.end());

describe('export declarations', () => {
  const sara = client(), aron = client();
  let odin = '', exporter = '', buyer = '', decl: any;
  const put = async (b: any) => { const r = await sara.put(`/declarations/${decl.id}`, { ...b, version: decl.version }); expect(r.status, JSON.stringify(r.body)).toBe(200); decl = r.body; return decl; };

  it('setup', async () => {
    const admin = client();
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    for (const [c, k, role] of [[sara, 'sara', 'specialist'], [aron, 'aron', 'approver']] as const) {
      const u = await admin.post('/admin/users', { name: k, email: `${k}@odin.test`, roles: [role] });
      await c.post('/auth/login', { email: `${k}@odin.test`, password: u.body.temporaryPassword });
      await c.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    }
    const mk = async (name: string, country: string, org: string | null, roles: string[], credit?: string) => {
      const p = (await sara.post('/partners', { legal_name: name, registration_country: country })).body.partner;
      if (org) await sara.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      await sara.post(`/partners/${p.id}/rows/addresses`, { address_type: 'REGISTERED', street: 'Gate 1', city: 'By', country_code: country, is_standard: true });
      for (const r of roles) await sara.post(`/partners/${p.id}/rows/roles`, { role_code: r });
      if (credit) await sara.post(`/partners/${p.id}/rows/credit`, { account: credit, payment_type: 'TOLLKREDITT' });
      return p.id as string;
    };
    odin = await mk('ODIN CUSTOMS AS', 'NO', '931481274', ['DEC', 'REP']);
    exporter = await mk('Nordlys Sjømat AS', 'NO', '923609016', ['EXP', 'DEB'], '412200');
    buyer = await mk('Fiskhandel Göteborg AB', 'SE', null, ['CON']);
    await pool.query(`INSERT INTO bp_fullmakt (partner_id, representative_id, scope, valid_from) VALUES ($1, $2, 'EXPORT', '2020-01-01')`, [exporter, odin]);
  });

  it('a new export: EXP number, type 1, the exporter as client; export boxes and code lists', async () => {
    const r = await sara.post('/declarations', { direction: 'EXPORT', exporter_id: exporter });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    decl = r.body;
    expect(decl).toMatchObject({ direction: 'EXPORT', decl_no: expect.stringMatching(/^EXP-\d{4}-\d{5}$/), decl_type: '1', client_id: exporter, declarant_id: odin });
    expect(rules(decl)).toEqual(expect.arrayContaining(['MANDATORY', 'NO_ITEMS']));
    expect(decl.issues.find((i: any) => i.field === 'destination_country')).toMatchObject({ box: '17a' });
    // Import codes are refused on an export (box 25 uses 10/20/30 …, box 1 uses 1/2/3/8/0).
    expect((await sara.put(`/declarations/${decl.id}`, { transport_mode: '3', version: decl.version })).status).toBe(400);
    expect((await sara.put(`/declarations/${decl.id}`, { decl_type: '4', version: decl.version })).status).toBe(400);
    expect((await sara.get('/declarations?direction=EXPORT')).body.map((d: any) => d.id)).toEqual([decl.id]);
    expect((await sara.get('/declarations')).body).toHaveLength(0);       // the import list
  });

  it('a complete export passes; box 46 in whole kroner; the export levy needs its group', async () => {
    await put({ importer_id: buyer, place: 'Oslo', destination_country: 'se', incoterms: 'DAP', incoterms_place: 'Göteborg', transaction_type: '01', transport_mode: '30',
      transport_id: 'EK12345', transport_nat: 'NO', exit_office: '3770', currency: 'EUR', invoice_total: 1000.5, invoice_type: 'N380', invoice_no: 'F-100', invoice_date: today,
      payment_method: 'TOLLKREDITT', payment_account: '412200', docs: [{ code: 'N380', ref: 'F-100' }] });
    const r = await sara.post(`/declarations/${decl.id}/items`, { version: decl.version, description: 'Fersk laks', code: '03021400', origin: 'NO', county: '46', packages: 20,
      package_kind: 'BX', gross_kg: 520, net_kg: 500, price: 1000.5, procedure: '1000', docs: [{ code: 'FD', ref: 'FD-2026-1' }] });
    decl = r.body;
    expect(decl.box1).toBe('EU');
    expect(decl.calc).toMatchObject({ direction: 'EXPORT', fx: 11, fxSource: 'TOLLETATEN', statValue: 11006 });   // 1 000,50 × 11 = 11 005,5 → 11 006
    expect(decl.calc.lines[0].levy).toMatchObject({ type: 'FA', group: 1, provisional: true, amount: 28 });       // 0,25 % of 11 006 = 27,5 → 28
    expect(rules(decl)).toEqual(['LEVY_GROUP']);
    await sara.put(`/declarations/${decl.id}/items/${decl.items[0].id}`, { version: decl.version, levy_group: '2' });
    decl = (await sara.get(`/declarations/${decl.id}`)).body;
    expect(decl.calc.lines[0].levy).toMatchObject({ group: 2, provisional: false, amount: 17 });                 // 0,15 % = 16,5 → 17
    expect(decl.check).toMatchObject({ ok: true, warnings: 0 });
  });

  it('the export rules: exit office vs transport mode, Norway as destination, sea-only Incoterms, county, procedure and storage, DOK, J', async () => {
    await put({ transport_mode: '40' });                       // air at Svinesund: illogical per Tolletaten
    expect(rules(decl)).toContain('EXIT_MODE_ILLOGICAL');
    await put({ transport_mode: '30', incoterms: 'FOB', destination_country: 'NO' });
    expect(rules(decl)).toEqual(expect.arrayContaining(['INCOTERM_SEA_ONLY', 'DEST_NO']));
    await put({ incoterms: 'DAP', destination_country: 'SE' });
    const it0 = decl.items[0];
    // Box 36 = J does not exist on export: refused when saved.
    expect((await sara.put(`/declarations/${decl.id}/items/${it0.id}`, { version: decl.version, preference: 'J' })).status).toBe(400);
    let r = await sara.put(`/declarations/${decl.id}/items/${it0.id}`, { version: decl.version, origin: 'CN', county: '46', procedure: '1070' });
    expect(rules(r.body)).toEqual(expect.arrayContaining(['COUNTY_ORIGIN', 'PROC_STORAGE']));
    r = await sara.put(`/declarations/${r.body.id}/items/${it0.id}`, { version: r.body.version, origin: 'NO', preference: 'N', procedure: '3050' });
    expect(rules(r.body)).toContain('DOK_REQUIRED');
    r = await sara.put(`/declarations/${r.body.id}/items/${it0.id}`, { version: r.body.version, procedure: '2000' });
    expect(rules(r.body)).toContain('PROC_MISMATCH');           // 2xxx with box 1 = 1
    r = await sara.put(`/declarations/${r.body.id}/items/${it0.id}`, { version: r.body.version, procedure: '1000', docs: [] });
    expect(r.body.issues.find((i: any) => i.rule === 'RESTRICTION').msg).toMatch(/FD Fangstdokument.*FD eller FS \(eller UND\)/);
    decl = (await sara.put(`/declarations/${r.body.id}/items/${it0.id}`, { version: r.body.version, docs: [{ code: 'UND', ref: 'S2026/1' }] })).body;
    expect(rules(decl)).not.toContain('RESTRICTION');
  });

  it('a car needs its chassis number; waste restrictions are information only; container numbers follow ISO 6346', async () => {
    let r = await sara.post(`/declarations/${decl.id}/items`, { version: decl.version, description: 'Personbil', code: '87032310', origin: 'NO', county: '03', packages: 1,
      gross_kg: 1400, net_kg: 1400, price: 1, procedure: '1000', levy_group: null });
    const car = r.body.issues.filter((i: any) => i.item === 2).map((i: any) => [i.rule, i.lvl]);
    expect(car).toEqual(expect.arrayContaining([['CHASSIS', 'warn'], ['RESTRICTION_WASTE', 'info']]));
    expect(validContainerNo('CSQU3054383')).toBe(true);
    expect(validContainerNo('CSQU3054384')).toBe(false);
    r = await sara.put(`/declarations/${decl.id}`, { version: r.body.version, container: true, container_nos: 'CSQU3054384' });
    expect(rules(r.body)).toContain('CONTAINER_ISO6346');
    decl = (await sara.put(`/declarations/${decl.id}`, { version: r.body.version, container: false, container_nos: null })).body;
    decl = (await sara.post(`/declarations/${decl.id}/items/${decl.items[1].id}/remove`, { version: decl.version })).body;
  });

  it('submit, approve, the simulator clears it for exit at the exit office', async () => {
    await put({ invoice_total: 1000.5 });
    expect(decl.check.ok, JSON.stringify(decl.issues)).toBe(true);
    await sara.post(`/declarations/${decl.id}/submit`, {});
    await aron.post(`/declarations/${decl.id}/approve`, {});
    let d = decl;
    for (let i = 0; i < 50 && d.status !== 'ACCEPTED'; i++) { await new Promise(r => setTimeout(r, 100)); d = (await sara.get(`/declarations/${decl.id}`)).body; }
    expect(d.status).toBe('ACCEPTED');
    expect(d.versions[0].answer).toMatchObject({ decision: 'Klarert for utførsel' });
    expect(d.versions[0].answer.text).toMatch(/utpasseringstollsted 3770/);
    expect(d.mrn).toMatch(/^\d{2}NO377000[0-9A-F]{8}$/);
  });

  it('AI reading is for import only; copying keeps the direction', async () => {
    expect((await sara.post(`/declarations/${decl.id}/copy`, {})).body).toMatchObject({ direction: 'EXPORT', decl_no: expect.stringMatching(/^EXP-/), destination_country: 'SE' });
  });
});
