/**
 * Export declarations (phase 3a): code lists, the calculation and the rules. Pure: what they need arrives
 * in the context (repo.ts). Carried over from ODIN LINK 2.37 (src/export/codes.js and validation.js),
 * following Tolletaten's "Hvordan fylle ut utførselsdeklarasjon steg-for-steg" (25.9.2026).
 *
 * Severity, as checked against accepted declarations: err = TVINN rejects or the box is mandatory;
 * warn = needs a decision (a restriction may apply, codes do not fit); info = noted only (waste
 * restrictions U2/U3 sit on almost every code and apply only when the goods are waste).
 */
import type { Issue, Level, PartyInfo } from './rules.js';

export const EU_EFTA = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'CH'];
export const EU_ONLY = EU_EFTA.filter(c => !['IS', 'LI', 'CH'].includes(c));
/** Box 1 column 1 on export: EU for an EU/EFTA destination (box 17a), otherwise EX. */
export const box1Export = (dest: string | null | undefined) => (dest ? (EU_EFTA.includes(dest.toUpperCase()) ? 'EU' : 'EX') : null);

export const EXPEDITION_TYPES: Record<string, string> = { '1': 'Ordinær utførsel', '2': 'Midlertidig utførsel', '3': 'Gjenutførsel', '8': 'Direkte transitt/utførsel', '0': 'Proviant' };

/** Box 37. storage: allowed box 30 codes (null = box 30 must be empty); dok: reference to the earlier declaration; routing TO_NO: 15a ≠ NO, 17a = NO. */
type Proc = { desc: string; storage: string[] | null; dok?: 'required' | 'expected'; routing?: 'TO_NO' };
const P = (desc: string, storage: string[] | null = null, extra: Partial<Proc> = {}): Proc => ({ desc, storage, ...extra });
const ABCD = ['A', 'B', 'C', 'D'];
export const PROCEDURES: Record<string, Proc> = {
  '1000': P('Ordinær utførsel av norske varer'), '1070': P('Ordinær utførsel – varer fra tollager', ABCD),
  '1100': P('Ordinær utførsel av spesielle varer'), '1170': P('Ordinær utførsel av spesielle varer – fra tollager', ABCD),
  '2000': P('Midlertidig utførsel (ikke bearbeiding/reparasjon)'), '2040': P('Midlertidig utførsel – varer gått over til fri disponering'),
  '2041': P('Midlertidig utførsel av spesielle varer – fri disponering'), '2070': P('Midlertidig utførsel – fra tollager', ABCD),
  '2071': P('Midlertidig utførsel av utenlandske varer – fra tollager', ABCD), '2100': P('Midlertidig utførsel for bearbeiding'),
  '2140': P('Midlertidig utførsel for bearbeiding – fri disponering'), '2141': P('Midlertidig utførsel av spesielle varer for bearbeiding'),
  '2170': P('Midlertidig utførsel for bearbeiding – fra tollager', ABCD), '2171': P('Midlertidig utførsel av utenlandske varer for bearbeiding – fra tollager', ABCD),
  '2200': P('Midlertidig utførsel for reparasjon'), '2240': P('Midlertidig utførsel for reparasjon – fri disponering'),
  '2241': P('Midlertidig utførsel av spesielle varer for reparasjon'), '2270': P('Midlertidig utførsel for reparasjon – fra tollager', ABCD),
  '2271': P('Midlertidig utførsel av utenlandske varer for reparasjon – fra tollager', ABCD),
  '3040': P('Gjenutførsel – varer gått over til fri disponering', null, { dok: 'expected' }),
  '3041': P('Gjenutførsel av spesielle varer – fri disponering', null, { dok: 'expected' }),
  '3050': P('Gjenutførsel etter midlertidig innførsel', null, { dok: 'required' }),
  '3051': P('Gjenutførsel av industrivarer etter innenlands bearbeiding', null, { dok: 'required' }),
  '3052': P('Gjenutførsel etter midlertidig innførsel for reparasjon', null, { dok: 'required' }),
  '3057': P('Gjenutførsel av landbruksvarer etter innenlands bearbeiding', null, { dok: 'required' }),
  '3071': P('Gjenutførsel av utenlandske varer – fra tollager', ABCD), '3072': P('Gjenutførsel av utenlandske varer – fra tollager E', ['E']),
  '8000': P('Direkte transitt til kontinentalsokkelen / norskeide fartøy og luftfartøy', null, { routing: 'TO_NO' }),
  '8071': P('Direkte transitt til kontinentalsokkelen – fra tollager', ABCD, { routing: 'TO_NO' }),
  '8072': P('Direkte transitt til kontinentalsokkelen – fra tollager E', ['E']), '8100': P('Direkte transitt til utlandet'),
  '8171': P('Direkte transitt til utlandet – fra tollager', ['A', 'B']), '8172': P('Direkte transitt til utlandet – fra tollager E', ['E']),
  '8200': P('Direktelanding av fisk fra norske fartøy i utlandet'),
  '0100': P('Norsk proviant – norskeide fartøy/luftfartøy til utlandet'), '0140': P('Proviant fri disponering – norskeide fartøy/luftfartøy'),
  '0170': P('Proviant fra tollager – norskeide fartøy/luftfartøy', ['A', 'B', 'D']),
  '0200': P('Utenlandsk proviant i transitt – norskeide fartøy/luftfartøy', null, { routing: 'TO_NO' }),
  '0271': P('Utenlandsk proviant fra tollager – norskeide fartøy/luftfartøy', ['A', 'B'], { routing: 'TO_NO' }),
  '0300': P('Norsk proviant – faste installasjoner på kontinentalsokkelen'), '0340': P('Proviant fri disponering – kontinentalsokkelen'),
  '0370': P('Proviant fra tollager – kontinentalsokkelen', ['A', 'B', 'D']),
  '0400': P('Utenlandsk proviant i transitt – kontinentalsokkelen', null, { routing: 'TO_NO' }),
  '0471': P('Utenlandsk proviant fra tollager – kontinentalsokkelen', ['A', 'B'], { routing: 'TO_NO' }),
  '0500': P('Norsk proviant – utenlandskeide fartøy/luftfartøy'), '0540': P('Proviant fri disponering – utenlandskeide fartøy/luftfartøy'),
  '0600': P('Utenlandsk proviant i transitt – utenlandskeide fartøy/luftfartøy'),
  '0671': P('Utenlandsk proviant fra tollager – utenlandskeide fartøy/luftfartøy', ['A', 'B'])
};
export const TRANSACTION_TYPES: Record<string, string> = {
  '01': 'Salg mot vederlag, finansiell leasing', '02': 'Gratis erstatningsleveranser', '03': 'Gaver og andre leveranser uten kostnad',
  '04': 'Midlertidig utførsel for betalt bearbeiding', '05': 'Gjenutførsel etter betalt bearbeiding',
  '06': 'Midlertidig utførsel for/gjenutførsel etter reparasjon, leie, lån eller operasjonell leasing', '08': 'Bygg og anlegg, inkludert delsendinger',
  '09': 'Annet', '10': 'Varer i retur'
};
export const TRANSPORT_MODES: Record<string, string> = {
  '10': 'Fartøy', '12': 'Jernbanevogn på fartøy', '16': 'Bil på fartøy', '17': 'Tilhenger på fartøy', '20': 'Jernbane', '23': 'Bil/tilhenger på jernbane',
  '30': 'Bil (vegtransport)', '40': 'Luftfartøy', '50': 'Post', '70': 'Faste installasjoner (rør, kabler osv.)', '90': 'Egen fremdrift'
};
const NO_NATIONALITY = ['20', '50', '70'];
const SEA_MODES = ['10', '12', '16', '17'];
const SEA_ONLY_INCOTERMS = ['FAS', 'FOB', 'CFR', 'CIF'];
export const COUNTIES: Record<string, string> = {
  '03': 'Oslo', '11': 'Rogaland', '15': 'Møre og Romsdal', '18': 'Nordland', '21': 'Svalbard', '22': 'Jan Mayen', '23': 'Kontinentalsokkelen',
  '29': 'Norsk vare fra flere fylker', '31': 'Østfold', '32': 'Akershus', '33': 'Buskerud', '34': 'Innlandet', '39': 'Vestfold', '40': 'Telemark',
  '42': 'Agder', '46': 'Vestland', '50': 'Trøndelag', '55': 'Troms', '56': 'Finnmark', '91': 'Eksport av varer produsert i utlandet', '99': 'Ukjent opprinnelsesfylke'
};
export const PREFERENCES: Record<string, string> = {
  A: 'EØS-avtalen (EU-land og Island)', B: 'Bilateral handelsavtale EF–Norge', C: 'EFTA-konvensjonen (Sveits/Liechtenstein, Island)',
  G: 'Norsk GSP-system', P: 'Andre frihandelsavtaler', N: 'Ikke opprinnelsesbevis'
};
export const STORAGE_TYPES = ['A', 'B', 'C', 'D', 'E'];
export const COLLECTIVE_CODES: Record<string, string> = { '00000077': 'Flyttegods, reisegods og personlige effekter', '00000088': 'Gaveforsendelser fra privatperson til privatperson',
  '00000099': 'Forenklet tariffering (total under NOK 1 000)' };
const SIMPLIFIED_LIMIT_NOK = 1000;
export const INVOICE_TYPES: Record<string, string> = { N380: 'Handelsfaktura', N325: 'Proformafaktura', ZZZ: 'Annet grunnlag' };
/** Restriction type → box 44 codes that document compliance; UND (exemption document) covers every type. */
const RESTRICTION_DOCS: Record<string, string[]> = { U1: ['U1'], U2: ['U2'], U3: ['U3'], L3: ['L3'], B3: ['B3'], B4: ['B4'], K5: ['K5'], FD: ['FD', 'FS'], S1: ['S1'],
  W1: ['W1', 'CIT'], W2: ['W2', 'CIT'], TB: ['TB'], DA: ['DA'], MR: ['GEN', 'TXT'], M4: [] };
const INFO_ONLY = ['U2', 'U3'];

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** ISO 6346 container number with check digit. */
export function validContainerNo(s: string) {
  const v = up(s).replace(/[\s-]/g, '');
  if (!/^[A-Z]{3}[UJZR]\d{7}$/.test(v)) return false;
  const val = (ch: string) => { if (/\d/.test(ch)) return Number(ch); const n = ch.charCodeAt(0) - 55; return n + Math.floor((n - 1) / 10); };
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += val(v[i]) * 2 ** i;
  return (sum % 11) % 10 === Number(v[10]);
}

/* ------------------------------ calculation ------------------------------ */
export interface ExportLevy { levy_type: string; levy_group: number | null; rate: string | number; unit: string | null; group_text: string | null }
export interface ExportCalcContext { date: string; currency: string | null; fx: number | null; fxSource: 'NOK' | 'MANUAL' | 'TOLLETATEN' | 'NONE'; levies: Record<string, ExportLevy[]> }

/** Box 46 in whole kroner (price × rate, or set by hand), and the export levy (box 47). */
export function calculateExport(items: any[], cx: ExportCalcContext) {
  const lines = items.map(it => {
    const computed = cx.fx != null ? Math.round(num(it.price) * cx.fx) : null;
    const sv = !blank(it.stat_value) ? Math.round(num(it.stat_value)) : computed;
    const rows = cx.levies[it.code] ?? [];
    const chosen = !blank(it.levy_group) ? rows.find(r => String(r.levy_group) === String(it.levy_group).trim()) : null;
    const row = chosen ?? (rows.length === 1 ? rows[0] : rows.length ? [...rows].sort((a, b) => (a.levy_group ?? 0) - (b.levy_group ?? 0))[0] : null);
    const amount = row && (row.unit ?? 'P') === 'P' && sv != null ? Math.round(sv * num(row.rate) / 100) : 0;
    return { line_no: it.line_no, code: it.code, customsValue: sv, statComputed: computed, statOverridden: !blank(it.stat_value) && computed != null && Math.round(num(it.stat_value)) !== computed,
      levy: row ? { type: row.levy_type, group: row.levy_group, rate: num(row.rate), unit: row.unit, amount, provisional: !chosen && rows.length > 1,
        groups: rows.map(r => ({ group: r.levy_group, rate: num(r.rate), text: r.group_text })) } : null,
      payable: amount, total: amount };
  });
  const sum = (k: 'customsValue' | 'payable') => lines.reduce((s, l) => s + num(l[k]), 0);
  return { direction: 'EXPORT' as const, currency: cx.currency, fx: cx.fx, fxSource: cx.fxSource, date: cx.date, lines,
    statValue: sum('customsValue'), levy: sum('payable'), payable: sum('payable'), total: sum('payable'), duty: 0, rt: 0, fa: 0, saer: 0, tillegg: 0, vat: 0, vatBase: 0,
    incomplete: cx.fx == null };
}
export type ExportCalc = ReturnType<typeof calculateExport>;

/* ------------------------------ rules ------------------------------ */
export interface ExportRuleContext {
  decl: Record<string, any>; items: Record<string, any>[]; today: string;
  parties: Partial<Record<'exporter_id' | 'importer_id' | 'declarant_id', PartyInfo | null>>;
  fullmakt?: { valid: boolean; expiredTo?: string | null } | null;
  tariffLoaded: boolean; tariff: Record<string, { level: string; supp_unit: string | null; supp_text: string | null } | null>;
  restrictions: Record<string, { rtype: string; rtype_text: string | null; rgroup_text: string | null }[]>;
  refsLoaded: boolean; refs: Record<string, boolean>;
  exitOfficesLoaded: boolean; exitOffice: { code: string; name: string; illogical_modes: string[] } | null;
  currencyKnown: boolean; credit?: { status: string } | null;
  calc: ExportCalc; openReviews?: number;
}

export const EXPORT_MANDATORY: [string, string, string][] = [
  ['decl_type', '1', 'Ekspedisjonstype'], ['decl_date', '54', 'Deklarasjonsdato'], ['place', '54', 'Sted'], ['exporter_id', '2', 'Avsender / eksportør'],
  ['importer_id', '8', 'Mottaker'], ['declarant_id', '14', 'Deklarant / representant'], ['destination_country', '17a', 'Bestemmelsesland'],
  ['incoterms', '20', 'Leveringsvilkår'], ['incoterms_place', '20', 'Leveringssted'], ['transaction_type', '24', 'Transaksjonstype'], ['transport_mode', '25', 'Transportmåte ved grensen']
];

export function checkExport(cx: ExportRuleContext): Issue[] {
  const d = cx.decl, items = cx.items, calc = cx.calc;
  const out: Issue[] = [];
  const add = (lvl: Level, box: string, rule: string, msg: string, extra: Partial<Issue> = {}) => out.push({ lvl, box, rule, msg, ...extra });
  const declDocs: any[] = Array.isArray(d.docs) ? d.docs : [];
  const date = d.decl_date ?? cx.today;

  for (const [field, box, label] of EXPORT_MANDATORY) if (blank(d[field])) add('err', box, 'MANDATORY', `Rubrikk ${box} (${label}) er obligatorisk.`, { field });
  const type = String(d.decl_type ?? '');
  if (type && !EXPEDITION_TYPES[type]) add('err', '1', 'EXP_TYPE', `Rubrikk 1: ekspedisjonstype «${type}» finnes ikke (1, 2, 3, 8 eller 0).`, { field: 'decl_type' });

  /* 15 / 17: destination, and the procedures routed to Norway (continental shelf, Norwegian vessels). */
  const dest = up(d.destination_country);
  const procs = [...new Set(items.map(it => String(it.procedure ?? '')).filter(Boolean))];
  const toNo = procs.some(p => PROCEDURES[p]?.routing === 'TO_NO');
  if (toNo) {
    if (dest && dest !== 'NO') add('err', '17a', 'DEST_MUST_BE_NO', `Rubrikk 17a: prosedyre ${procs.join('/')} tillater bare NO som bestemmelsesland.`, { field: 'destination_country' });
    if (blank(d.dispatch_country)) add('err', '15', 'DISPATCH_REQUIRED', `Rubrikk 15a må fylles ut for prosedyre ${procs.join('/')}.`, { field: 'dispatch_country' });
    else if (up(d.dispatch_country) === 'NO') add('err', '15', 'DISPATCH_NOT_NO', 'Rubrikk 15a: NO er ikke tillatt som avsenderland for denne prosedyren.', { field: 'dispatch_country' });
  } else if (dest === 'NO') add('err', '17a', 'DEST_NO', 'Rubrikk 17a: Norge kan ikke være bestemmelsesland ved utførsel (Svalbard og Jan Mayen = SJ).', { field: 'destination_country' });

  /* 19 container. */
  if (d.container) {
    const nos = [d.container_nos, ...items.map(it => it.container_no)].filter(v => !blank(v)).flatMap(v => String(v).split(/[,;]\s*/));
    if (!nos.length) add('err', '19', 'CONTAINER_NO', 'Rubrikk 19 er Ja — containernummer må oppgis.', { field: 'container_nos' });
    for (const c of nos) if (!validContainerNo(c)) add('warn', '19', 'CONTAINER_ISO6346', `Containernummer ${c} følger ikke ISO 6346 (format eller kontrollsiffer).`, { field: 'container_nos' });
  }

  /* 20 / 25 / 21 / 18 / 29 transport. */
  const inco = up(d.incoterms), mode = String(d.transport_mode ?? '');
  if (mode && !TRANSPORT_MODES[mode]) add('err', '25', 'TRANSPORT_MODE', `Rubrikk 25: transportmåte «${mode}» finnes ikke for utførsel.`, { field: 'transport_mode' });
  if (SEA_ONLY_INCOTERMS.includes(inco) && mode && !SEA_MODES.includes(mode))
    add('warn', '20', 'INCOTERM_SEA_ONLY', `Rubrikk 20: ${inco} brukes bare ved sjøtransport, men rubrikk 25 er ${mode}.`, { field: 'incoterms' });
  const needsNat = mode && !NO_NATIONALITY.includes(mode);
  if (needsNat && blank(d.transport_nat)) add('err', '21', 'NATIONALITY_REQUIRED', 'Rubrikk 21: oppgi nasjonaliteten til det aktive transportmidlet ved utpassering.', { field: 'transport_nat' });
  if (!needsNat && mode && !blank(d.transport_nat)) add('warn', '21', 'NATIONALITY_NOT_USED', 'Rubrikk 21 skal ikke fylles ut ved post, jernbane eller faste installasjoner.', { field: 'transport_nat' });
  if (needsNat && blank(d.transport_id)) add('warn', '18', 'TRANSPORT_ID', 'Rubrikk 18: transportmidlets identitet ved avgang mangler.', { field: 'transport_id' });
  const exitRequired = !procs.length || !procs.every(p => /^0|^80|^82/.test(p));
  if (blank(d.exit_office)) { if (exitRequired) add('err', '29', 'MANDATORY', 'Rubrikk 29 (Utpasseringstollsted) er obligatorisk.', { field: 'exit_office' }); }
  else if (cx.exitOfficesLoaded) {
    const o = cx.exitOffice;
    if (!o) add('err', '29', 'EXIT_OFFICE_UNKNOWN', `Rubrikk 29: ${d.exit_office} er ikke et kjent utpasseringstollsted.`, { field: 'exit_office' });
    else if (mode && o.illogical_modes.includes(mode))
      add('err', '29', 'EXIT_MODE_ILLOGICAL', `Rubrikk 25/29: transportmåte ${mode} (${TRANSPORT_MODES[mode] ?? ''}) er ulogisk for ${o.name} ${o.code} ifølge Tolletatens oversikt.`, { field: 'exit_office' });
  }

  /* 22 / 23 / 24 value and transaction. */
  const tt = String(d.transaction_type ?? '').padStart(2, '0');
  if (!blank(d.transaction_type) && !TRANSACTION_TYPES[tt]) add('err', '24', 'TRANSACTION_TYPE', `Rubrikk 24: transaksjonstype «${d.transaction_type}» finnes ikke.`, { field: 'transaction_type' });
  if (tt === '01' && (blank(d.invoice_total) || blank(d.currency)))
    add('err', '22', 'INVOICE_REQUIRED', 'Rubrikk 22: valuta og fakturabeløp må oppgis når varene betales (transaksjonstype 01).', { field: 'invoice_total' });
  if (!blank(d.currency) && !cx.currencyKnown) add('err', '22', 'CURRENCY_UNKNOWN', `Valuta ${d.currency} finnes ikke i Tolletatens valutaliste.`, { field: 'currency' });
  if (!blank(d.currency) && calc.fx == null) add('err', '23', 'FX_MISSING', `Rubrikk 23: ingen tollkurs for ${d.currency} på ${date} — oppgi kursen manuelt.`, { field: 'fx_manual' });
  if (!blank(d.invoice_total) && items.length) {
    const sum = items.reduce((s, it) => s + num(it.price), 0);
    if (Math.abs(sum - num(d.invoice_total)) > Math.max(1, num(d.invoice_total) * 0.005))
      add('warn', '22', 'VALUE_MISMATCH', `Rubrikk 22 (${num(d.invoice_total).toFixed(2).replace('.', ',')}) avviker fra summen av rubrikk 42 (${sum.toFixed(2).replace('.', ',')}).`, { field: 'invoice_total' });
  }
  const heads = procs.map(p => p.slice(0, 2));
  if (tt === '04' && heads.length && !heads.every(p => p === '21')) add('warn', '24', 'TRANSACTION_PROC', 'Rubrikk 24: transaksjonstype 04 (bearbeiding) forventer prosedyre 21xx.', { field: 'transaction_type' });
  if (tt === '05' && heads.length && !heads.every(p => p === '30')) add('warn', '24', 'TRANSACTION_PROC', 'Rubrikk 24: transaksjonstype 05 (gjenutførsel etter bearbeiding) forventer prosedyre 30xx.', { field: 'transaction_type' });

  /* 28 invoice, 30 / 49 storage. */
  if (blank(d.invoice_no) && blank(d.invoice_date)) add('warn', '28', 'INVOICE_REF', 'Rubrikk 28: oppgi fakturanummer og dato (er fakturaen ikke nummerert, bare dato).', { field: 'invoice_no' });
  const storage = up(d.storage_type);
  if (storage && !STORAGE_TYPES.includes(storage)) add('err', '30', 'STORAGE_CODE', 'Rubrikk 30: lagringssted oppgis med tollagerkode A, B, C, D eller E.', { field: 'storage_type' });
  if (storage && blank(d.warehouse_id)) add('err', '49', 'WAREHOUSE_ID', 'Rubrikk 49: lagerkode/godsnummer må oppgis når varene utføres fra tollager.', { field: 'warehouse_id' });
  if (!blank(d.warehouse_id) && String(d.warehouse_id).replace(/\s/g, '').length !== 15) add('warn', '49', 'WAREHOUSE_ID_FORMAT', 'Rubrikk 49: godsnummeret består av 15 tegn.', { field: 'warehouse_id' });

  /* Parties. */
  const exp = cx.parties.exporter_id, cons = cx.parties.importer_id, rep = cx.parties.declarant_id;
  for (const [field, box, p] of [['exporter_id', '2', exp], ['importer_id', '8', cons], ['declarant_id', '14', rep]] as const) {
    if (!p) continue;
    if (p.status !== 'ACTIVE') add('err', box, 'PARTNER_INACTIVE', `Rubrikk ${box}: ${p.name} er inaktiv og kan ikke brukes i en ny deklarasjon.`, { field });
    if (!p.hasStandardAddress) add('warn', box, 'PARTNER_ADDRESS_MISSING', `Rubrikk ${box}: ${p.name} har ingen standardadresse gyldig per ${date}.`, { field });
  }
  if (exp && !exp.orgNo && !exp.personNo) add('err', '2', 'EXPORTER_NO', `Rubrikk 2: ${exp.name} mangler organisasjonsnummer eller fødselsnummer.`, { field: 'exporter_id' });
  if (exp && exp.country !== 'NO') add('warn', '2', 'EXPORTER_FOREIGN', `Rubrikk 2: eksportøren ${exp.name} er registrert i ${exp.country}. Kontroller at riktig avsender er valgt.`, { field: 'exporter_id' });
  if (cons && cons.country === 'NO' && !toNo) add('warn', '8', 'CONSIGNEE_NO', `Rubrikk 8: mottakeren ${cons.name} er registrert i Norge — oppgi den som mottar varen i utlandet.`, { field: 'importer_id' });
  if (rep && exp && d.declarant_id !== d.exporter_id && rep.roles.includes('REP') && cx.fullmakt !== undefined && !cx.fullmakt?.valid)
    add('warn', '14', 'FULLMAKT_MISSING', `Rubrikk 14: ingen gyldig fullmakt fra ${exp.name} til ${rep.name} per ${date}.`, { field: 'declarant_id' });

  /* 44 shipment documents. */
  const docCheck = (list: any[], where: string, extra: Partial<Issue>) => {
    for (const x of list) {
      const code = up(x.code);
      if (cx.refsLoaded && code && !cx.refs[code] && !['N380', 'N325', 'N271', 'N730', 'ZZZ'].includes(code))
        add('err', '44', 'DOC_CODE_UNKNOWN', `${where}: «${code}» er ikke en gyldig referansekode ved utførsel.`, extra);
      if (code === 'TXT' && blank(x.ref)) add('err', '44', 'DOC_TXT_EMPTY', `${where}: TXT uten tekst.`, extra);
      else if (code !== 'TXT' && blank(x.ref) && !['FOR', 'DEL'].includes(code)) add('warn', '44', 'DOC_REF', `${where}: ${code} mangler referanse/nummer.`, extra);
    }
  };
  docCheck(declDocs, 'Rubrikk 44', { field: 'docs' });

  /* Goods items. */
  if (!items.length) add('err', '32', 'NO_ITEMS', 'En deklarasjon må ha minst én varepost.');
  for (const it of items) {
    const n = Number(it.line_no);
    const I = (lvl: Level, box: string, rule: string, msg: string, field?: string) => add(lvl, box, rule, `Varepost ${n}: ${msg}`, { item: n, field });
    const docs: any[] = [...(Array.isArray(it.docs) ? it.docs : []), ...declDocs];
    const code = String(it.code ?? '');
    if (blank(it.description)) I('err', '31', 'ITEM_DESC', 'rubrikk 31 varebeskrivelse er obligatorisk.', 'description');
    if (!(Number(it.packages) > 0) && !/bulk/i.test(String(it.package_kind ?? ''))) I('err', '31', 'ITEM_PKG', 'rubrikk 31: oppgi antall kolli (eller «bulk» som kollislag).', 'packages');
    const collective = COLLECTIVE_CODES[code];
    let t: ExportRuleContext['tariff'][string] = null;
    if (!code) I('err', '33', 'ITEM_CODE', 'rubrikk 33 varenummer er obligatorisk.', 'code');
    else if (!collective && cx.tariffLoaded) {
      t = cx.tariff[code] ?? null;
      if (!t) I('err', '33', 'CODE_UNKNOWN', `varenummer ${code} finnes ikke i tolltariffen.`, 'code');
      else if (t.level !== 'Code') I('err', '33', 'CODE_NOT_LEAF', `${code} er ikke et deklarerbart åttesifret varenummer.`, 'code');
    }
    const line = calc.lines.find(l => l.line_no === n);
    if (collective) {
      if (code === '00000099' && (line?.customsValue ?? 0) >= SIMPLIFIED_LIMIT_NOK) I('err', '33', 'SIMPLIFIED_LIMIT', `forenklet tariffering (0000 00 99) kan bare brukes når totalverdien er under ${SIMPLIFIED_LIMIT_NOK} kr.`, 'code');
      if (items.length === 1 && code === '00000099') I('warn', '33', 'SIMPLIFIED_SINGLE', 'forenklet tariffering brukes ikke for sendinger med bare ett varenummer.', 'code');
    }
    const org = up(it.origin);
    if (!org) I('err', '34', 'ITEM_ORIGIN', 'rubrikk 34a opprinnelsesland er obligatorisk.', 'origin');
    const county = String(it.county ?? '').padStart(2, '0');
    if (blank(it.county)) I('err', '34', 'COUNTY', 'rubrikk 34b opprinnelses-/produksjonsfylke er obligatorisk (91 = produsert i utlandet).', 'county');
    else if (!COUNTIES[county]) I('err', '34', 'COUNTY', `rubrikk 34b: fylkeskode ${it.county} finnes ikke.`, 'county');
    else if (org && org !== 'NO' && !['91', '99'].includes(county))
      I('warn', '34', 'COUNTY_ORIGIN', `opprinnelsesland ${org} med norsk fylke ${county} — riktig bare hvis eksportverdien er minst dobbelt så høy som importverdien. Ellers 91.`, 'county');
    else if (org === 'NO' && county === '91') I('warn', '34', 'COUNTY_ORIGIN', 'opprinnelsesland NO, men fylke 91 (produsert i utlandet).', 'county');
    if (!(num(it.gross_kg) > 0)) I('err', '35', 'ITEM_GROSS', 'rubrikk 35 bruttovekt må være større enn null.', 'gross_kg');
    if (!(num(it.net_kg) > 0)) I('err', '38', 'ITEM_NET', 'rubrikk 38 nettovekt må være større enn null.', 'net_kg');
    if (num(it.net_kg) > num(it.gross_kg) && num(it.gross_kg) > 0) I('warn', '35', 'NET_OVER_GROSS', 'nettovekten er større enn bruttovekten.', 'gross_kg');
    const pref = up(it.preference || 'N');
    if (pref === 'J') I('err', '36', 'PREF_J', 'rubrikk 36: J skal ikke brukes ved utførsel.', 'preference');
    else if (!PREFERENCES[pref]) I('err', '36', 'PREF_CODE', `rubrikk 36: «${it.preference}» er ikke en gyldig preferansekode ved utførsel.`, 'preference');
    else if (pref !== 'N') {
      if (!docs.some(x => up(x.code) === 'SER')) I('err', '36', 'PREF_NO_PROOF', `preferansekode ${pref} krever opprinnelsesbevis (SER) i rubrikk 44.`, 'preference');
      if (pref === 'A' && dest && !EU_ONLY.includes(dest) && dest !== 'IS') I('warn', '36', 'PREF_DEST', `kode A (EØS) passer ikke for bestemmelsesland ${dest}.`, 'preference');
      if (pref === 'C' && dest && !['CH', 'LI', 'IS'].includes(dest)) I('warn', '36', 'PREF_DEST', `kode C (EFTA) passer ikke for bestemmelsesland ${dest}.`, 'preference');
      if (pref === 'B' && dest && !EU_ONLY.includes(dest)) I('warn', '36', 'PREF_DEST', `kode B (EF–Norge) passer ikke for bestemmelsesland ${dest}.`, 'preference');
    }
    const proc = String(it.procedure ?? ''), pdef = PROCEDURES[proc];
    if (!proc) I('err', '37', 'ITEM_PROCEDURE', 'rubrikk 37 prosedyre er obligatorisk.', 'procedure');
    else if (!pdef) I('err', '37', 'PROC_UNKNOWN', `rubrikk 37: prosedyrekode ${proc} finnes ikke for utførsel.`, 'procedure');
    else {
      if (EXPEDITION_TYPES[type] && proc[0] !== type) I('err', '37', 'PROC_MISMATCH', `rubrikk 37 (${proc}) må begynne med ekspedisjonstypen i rubrikk 1 (${type}).`, 'procedure');
      if (pdef.storage && !storage) I('err', '30', 'PROC_STORAGE', `prosedyre ${proc} (fra tollager) krever lagringssted i rubrikk 30 (${pdef.storage.join('/')}).`, 'procedure');
      if (pdef.storage && storage && !pdef.storage.includes(storage)) I('err', '30', 'PROC_STORAGE', `prosedyre ${proc} tillater lagringssted ${pdef.storage.join('/')}, ikke ${storage}.`, 'procedure');
      if (!pdef.storage && storage) I('err', '30', 'PROC_NO_STORAGE', `rubrikk 30 skal ikke fylles ut for prosedyre ${proc}.`, 'procedure');
      const hasDok = docs.some(x => up(x.code) === 'DOK' && !blank(x.ref)) || !blank(d.prev_doc);
      if (pdef.dok === 'required' && !hasDok) I('err', '44', 'DOK_REQUIRED', `gjenutførsel (${proc}) krever referanse til innførselsdeklarasjonen som skal skrives av (DOK i rubrikk 44).`, 'docs');
      if (pdef.dok === 'expected' && !hasDok) I('warn', '44', 'DOK_EXPECTED', `gjenutførsel (${proc}): oppgi gjerne innførselsdeklarasjonen (DOK) i rubrikk 44.`, 'docs');
    }
    if (t && t.supp_unit && !/^\s*kg\.?\s*$|kilo/i.test(`${t.supp_unit} ${t.supp_text ?? ''}`) && !(num(it.supp_qty) > 0))
      I('err', '41', 'SUPP_UNIT', `varenummeret krever mengde i annen enhet (${t.supp_text || t.supp_unit}).`, 'supp_qty');
    if (!(num(it.price) > 0)) I('err', '42', 'ITEM_PRICE', 'rubrikk 42 varens pris må være større enn null.', 'price');
    if (line?.statOverridden) I('info', '46', 'STAT_OVERRIDE', `rubrikk 46 er satt manuelt til ${line.customsValue} kr (beregnet ${line.statComputed}). Kontroller verdigrunnlaget.`, 'stat_value');
    const restr = cx.restrictions[code] ?? [];
    if (restr.some(r => r.rtype === 'M4') && blank(it.chassis)) I('warn', '31', 'CHASSIS', 'varenummeret krever understellsnummer (chassisnummer) i rubrikk 31.', 'chassis');
    const have = docs.map(x => up(x.code)), seen = new Set<string>();
    for (const r of restr) {
      if (seen.has(r.rtype) || r.rtype === 'M4') continue;
      seen.add(r.rtype);
      const want = RESTRICTION_DOCS[r.rtype] ?? [r.rtype];
      if (have.some(c => want.includes(c) || c === 'UND')) continue;
      const what = `${r.rtype} ${r.rgroup_text || r.rtype_text || ''}`.trim();
      if (INFO_ONLY.includes(r.rtype)) I('info', '44', 'RESTRICTION_WASTE', `${what}: gjelder bare hvis varen er avfall (da kreves ${want.join('/')} i rubrikk 44).`, 'docs');
      else I('warn', '44', 'RESTRICTION', `${what}: kontroller om utførselen krever tillatelse — oppgi ${want.length ? `${want.join(' eller ')} (eller UND)` : 'UND'} i rubrikk 44 hvis den gjelder.`, 'docs');
    }
    if (collective && restr.some(r => !INFO_ONLY.includes(r.rtype))) I('err', '33', 'COLLECTIVE_RESTRICTED', 'samlenummer/forenklet tariffering kan ikke brukes for restriksjonsbelagte varer.', 'code');
    if (line?.levy?.provisional)
      I('warn', '47', 'LEVY_GROUP', `varenummeret har flere avgiftsgrupper for ${line.levy.type} (${line.levy.groups.map(g => `${g.group}: ${g.rate} %`).join(', ')}). Velg avgiftsgruppe — beregnet foreløpig med gruppe ${line.levy.group}.`, 'levy_group');
    docCheck(Array.isArray(it.docs) ? it.docs : [], `Varepost ${n}, rubrikk 44`, { item: n, field: 'docs' });
  }

  /* 48: an export levy needs a credit account. */
  if (calc.levy > 0 && blank(d.payment_account)) add('err', '48', 'CREDIT_ACCOUNT', `Rubrikk 48: eksportavgift ${round2(calc.levy)} kr skal betales — oppgi konto for tollkreditt.`, { field: 'payment_account' });
  else if (calc.levy > 0 && cx.credit === null) add('warn', '48', 'CREDIT_UNKNOWN', `Rubrikk 48: konto ${d.payment_account} er ikke registrert.`, { field: 'payment_account' });
  else if (calc.levy > 0 && cx.credit && cx.credit.status !== 'ACTIVE') add('err', '48', 'CREDIT_INACTIVE', `Rubrikk 48: konto ${d.payment_account} er ikke aktiv.`, { field: 'payment_account' });

  if (cx.openReviews) add('warn', 'AI', 'REVIEW_OPEN', `${cx.openReviews} kontrollpunkt${cx.openReviews === 1 ? '' : 'er'} fra AI-lesingen er ikke avklart. Alle må avklares før innsending.`);
  return out;
}
