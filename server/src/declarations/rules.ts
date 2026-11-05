/**
 * The import declaration rules (phase 2a). Pure: everything a rule needs arrives in the context, which
 * src/declarations/repo.ts loads from the database. Carried over from ODIN LINK 2.37 src/validation.js
 * and src/partner-validation.js; the TVINN error number is named where the rule mirrors one.
 *
 * Levels: 'err' blocks submitting, 'warn' must be looked at, 'info' is for information.
 * The calculation rules (preference rates, RT100, levies, box 12, payment required) come with phase 2b.
 */
import { CHED_DOCS, DECL_DOC_CODES, NO_ACTIVE_MEANS, PREF_CLAIM_CODES, PREF_PROOF_DOCS, BOX_ROLES } from './codes.js';
import { B12_BASES, B12_TYPES, type DeclCalc } from './calc.js';

export type Level = 'err' | 'warn' | 'info';
export interface Issue { lvl: Level; box: string; rule: string; msg: string; item?: number; field?: string }

export interface PartyInfo {
  name: string; status: string; roles: string[]; hasStandardAddress: boolean; orgNo: string | null; personNo: string | null; country: string;
  registry?: { deleted?: boolean | null; bankrupt?: boolean | null; winding_up?: boolean | null; forced_dissolution?: boolean | null; vat_registered?: boolean | null; fetched_at?: string } | null;
  eoriInvalid?: string | null;
}
export interface RuleContext {
  decl: Record<string, any>;
  items: Record<string, any>[];
  today: string;
  parties: Partial<Record<'exporter_id' | 'importer_id' | 'declarant_id', PartyInfo | null>>;
  fullmakt?: { valid: boolean; expiredTo?: string | null; scope?: string } | null;
  tariffLoaded: boolean;
  tariff: Record<string, { level: string; supp_unit: string | null; supp_text: string | null; valid_from: string | null; valid_to: string | null } | null>;
  codeValidity: Record<string, { valid_from: string | null; valid_to: string | null }[]>;
  chedCodes: string[];
  officesLoaded: boolean;
  office: { code: string; name: string; direction: string | null; valid_from: string | null; valid_to: string | null } | null;
  proceduresLoaded: boolean;
  procedures: Record<string, boolean>;
  quotas: Record<string, { valid_from: string | null; valid_to: string | null; codes: string[] } | null>;
  currencyKnown: boolean;
  fxFound: boolean;
  credit?: { account: string; payment_type: string; status: string; valid_to: string | null; partner_name: string } | null;
  products: Record<string, { status: string; product_no: string }>;
  /** The calculation (phase 2b); rules that need it stay quiet without it. */
  calc?: DeclCalc;
  /** Open review points from the AI intake (phase 2c). */
  openReviews?: number;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const days = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
const inForce = (r: { valid_from: string | null; valid_to: string | null }, d: string) => (!r.valid_from || r.valid_from <= d) && (!r.valid_to || r.valid_to >= d);
const list = (ns: number[]) => ns.slice(0, 10).join(', ') + (ns.length > 10 ? ' …' : '');

/** The mandatory header boxes: field, box number, label. */
export const MANDATORY: [string, string, string][] = [
  ['decl_type', '1', 'Deklarasjonstype'], ['office', 'A', 'Tollsted'], ['decl_date', '54', 'Deklarasjonsdato'], ['place', '54a', 'Sted'],
  ['exporter_id', '2', 'Avsender / eksportør'], ['importer_id', '8', 'Mottaker / importør'], ['declarant_id', '14', 'Deklarant / representant'],
  ['dispatch_country', '15', 'Avsenderland'], ['transport_id', '18', 'Transportmidlets identitet'], ['transport_mode', '25', 'Transportmåte ved grensen'],
  ['incoterms', '20', 'Leveringsvilkår (Incoterms)'], ['incoterms_place', '20a', 'Leveringssted'], ['invoice_total', '22', 'Fakturert totalbeløp'],
  ['currency', '22a', 'Valuta'], ['goods_location', '30', 'Varens lagringssted']
];

export function check(cx: RuleContext): Issue[] {
  const d = cx.decl, items = cx.items;
  const out: Issue[] = [];
  const add = (lvl: Level, box: string, rule: string, msg: string, extra: Partial<Issue> = {}) => out.push({ lvl, box, rule, msg, ...extra });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.decl_date ?? '')) ? String(d.decl_date) : null;
  const on = date ?? cx.today;
  const declDocs: any[] = Array.isArray(d.docs) ? d.docs : [];

  /* ---------------- mandatory and conditional header boxes ---------------- */
  for (const [field, box, label] of MANDATORY)
    if (blank(d[field])) add('err', box, 'MANDATORY', `Rubrikk ${box} (${label}) er obligatorisk.`, { field });
  if (!blank(d.transport_mode) && !NO_ACTIVE_MEANS.includes(String(d.transport_mode)) && blank(d.transport_nat))
    add('err', '21', 'MANDATORY', 'Rubrikk 21 (Transportmidlets nasjonalitet) er obligatorisk for denne transportmåten.', { field: 'transport_nat' });
  if (d.container && blank(d.container_nos))
    add('err', '19', 'CONTAINER_NO', 'Rubrikk 19 er Ja — containernummer er påkrevd.', { field: 'container_nos' });
  if (d.decl_type === '7' && blank(d.warehouse_id))
    add('err', '49', 'WAREHOUSE_ID', 'Innlegg på tollager (rubrikk 1 = 7) krever lageridentifikasjon i rubrikk 49.', { field: 'warehouse_id' });
  if (!blank(d.currency) && !cx.currencyKnown)
    add('err', '22a', 'CURRENCY_UNKNOWN', `Valuta ${d.currency} finnes ikke i Tolletatens valutaliste.`, { field: 'currency' });

  /* ---------------- parties: boxes 2, 8, 14 ---------------- */
  for (const field of ['exporter_id', 'importer_id', 'declarant_id'] as const) {
    const p = cx.parties[field];
    if (!p) continue;
    const { box, roles } = BOX_ROLES[field];
    if (p.status !== 'ACTIVE') add('err', box, 'PARTNER_INACTIVE', `Rubrikk ${box}: ${p.name} er inaktiv og kan ikke brukes i en ny deklarasjon.`, { field });
    if (!roles.some(r => p.roles.includes(r)))
      add('warn', box, 'PARTNER_ROLE_MISMATCH', `Rubrikk ${box}: ${p.name} har ingen ${roles.join(' eller ')}-rolle per ${on}. Legg til rollen i Forretningspartner.`, { field });
    if (!p.hasStandardAddress) add('warn', box, 'PARTNER_ADDRESS_MISSING', `Rubrikk ${box}: ${p.name} har ingen standardadresse gyldig per ${on}.`, { field });
    const r = p.registry;
    if (r) {
      const bad = [r.deleted && 'slettet fra Enhetsregisteret', r.bankrupt && 'konkurs', r.winding_up && 'under avvikling', r.forced_dissolution && 'under tvangsavvikling'].filter(Boolean);
      if (bad.length) add('warn', box, 'PARTNER_REGISTRY_STATUS', `Rubrikk ${box}: ${p.name} er ${bad.join(', ')} ifølge Brønnøysund (kontrollert ${String(r.fetched_at ?? '').slice(0, 10)}).`, { field });
      if (field === 'importer_id' && r.vat_registered === false)
        add('warn', box, 'PARTNER_NOT_VAT_REGISTERED', `Rubrikk 8: ${p.name} er ikke registrert i Merverdiavgiftsregisteret ifølge Brønnøysund. Kontroller hvordan innførselsmerverdiavgiften skal gjøres opp.`, { field });
    }
    if (p.eoriInvalid) add('warn', box, 'PARTNER_EORI_INVALID', `Rubrikk ${box}: EORI ${p.eoriInvalid} for ${p.name} er ikke gyldig ifølge EUs EORI-tjeneste.`, { field });
    if (field === 'importer_id' && p.country === 'NO' && !p.orgNo && !p.personNo)
      add('warn', box, 'PARTNER_ORG_NO_MISSING', `Rubrikk 8: ${p.name} mangler organisasjonsnummer eller fødselsnummer.`, { field });
  }
  const rep = cx.parties.declarant_id, imp = cx.parties.importer_id;
  if (rep && imp && d.importer_id !== d.declarant_id && rep.roles.includes('REP') && cx.fullmakt !== undefined) {
    const f = cx.fullmakt;
    if (!f || !f.valid)
      add('warn', '14', 'FULLMAKT_MISSING', f?.expiredTo
        ? `Rubrikk 14: fullmakten fra ${imp.name} til ${rep.name} utløp ${f.expiredTo}.`
        : `Rubrikk 14: ingen gyldig fullmakt fra ${imp.name} til ${rep.name} per ${on}. Registrer den på partnerkortet (fanen Koblinger og fullmakt).`, { field: 'declarant_id' });
    else if (f.scope === 'EXPORT') add('warn', '14', 'FULLMAKT_SCOPE', `Rubrikk 14: fullmakten fra ${imp.name} gjelder bare utførsel.`, { field: 'declarant_id' });
  }
  if (!blank(d.exporter_id) && d.exporter_id === d.importer_id) add('warn', '8', 'SAME_PARTY', 'Avsender og mottaker er samme aktør.', { field: 'importer_id' });

  /* ---------------- box A: customs office ---------------- */
  if (!blank(d.office) && cx.officesLoaded) {
    const o = cx.office;
    if (!o) add('warn', 'A', 'OFFICE_UNKNOWN', `Rubrikk A: ${d.office} finnes ikke i Tolletatens liste over ekspedisjonsenheter. Velg tollstedet på nytt.`, { field: 'office' });
    else if (o.direction === 'Utførsel') add('err', 'A', 'OFFICE_EXPORT_ONLY', `Rubrikk A: ${o.code} ${o.name} er en ekspedisjonsenhet for utførsel.`, { field: 'office' });
    else if (!inForce(o, on)) add('err', 'A', 'OFFICE_EXPIRED', `Rubrikk A: ${o.code} ${o.name} er ikke gyldig på deklarasjonsdatoen.`, { field: 'office' });
  }

  /* ---------------- goods items ---------------- */
  if (!items.length) add('err', '32', 'NO_ITEMS', 'En deklarasjon må ha minst én varepost.');
  const seen = new Map<string, number>();
  for (const it of items) {
    const n = Number(it.line_no);
    const I = (lvl: Level, box: string, rule: string, msg: string, field?: string) => add(lvl, box, rule, `Varepost ${n}: ${msg}`, { item: n, field });
    const docs: any[] = [...(Array.isArray(it.docs) ? it.docs : []), ...declDocs];
    if (blank(it.description)) I('err', '31', 'ITEM_DESC', 'rubrikk 31 varebeskrivelse er obligatorisk.', 'description');
    if (blank(it.code)) I('err', '33', 'ITEM_CODE', 'rubrikk 33 varenummer er obligatorisk.', 'code');
    if (blank(it.origin)) I('err', '34', 'ITEM_ORIGIN', 'rubrikk 34 opprinnelsesland er obligatorisk.', 'origin');
    if (blank(it.procedure)) I('err', '37', 'ITEM_PROCEDURE', 'rubrikk 37 prosedyre er obligatorisk.', 'procedure');
    if (num(it.price) <= 0) I('err', '42', 'ITEM_PRICE', 'rubrikk 42 varens pris må være større enn null.', 'price');
    if (num(it.net_kg) <= 0) I('err', '38', 'ITEM_NET', 'rubrikk 38 nettovekt må være større enn null.', 'net_kg');
    if (num(it.gross_kg) > 0 && num(it.net_kg) > num(it.gross_kg)) I('warn', '35', 'NET_OVER_GROSS', 'nettovekten er større enn bruttovekten.', 'gross_kg');

    const code = blank(it.code) ? null : String(it.code);
    if (code && cx.tariffLoaded) {
      const t = cx.tariff[code];
      if (!t) I('err', '33', 'CODE_UNKNOWN', `varenummer ${code} finnes ikke i tolltariffen.`, 'code');
      else {
        if (t.level !== 'Code') I('err', '33', 'CODE_NOT_LEAF', `${code} er ikke et deklarerbart åttesifret varenummer.`, 'code');
        // A unit of kilogram is already reported by box 38; box 41 is for litres, pieces, pairs ...
        if (t.supp_unit && !/^\s*kg\.?\s*$|kilo/i.test(`${t.supp_unit} ${t.supp_text ?? ''}`) && num(it.supp_qty) <= 0)
          I('err', '41', 'SUPP_UNIT', `varenummeret krever mengde i annen enhet (${t.supp_text || t.supp_unit}).`, 'supp_qty');
        if (!inForce(t, on)) I('err', '33', 'CODE_NOT_VALID_ON_DATE', `varenummer ${code} er ikke gyldig på deklarasjonsdatoen.`, 'code');
      }
      // Datogyldighet lists date changes; a code is only flagged when every period ended before the date.
      const val = cx.codeValidity[code] ?? [];
      if (val.length && val.every(r => r.valid_to && r.valid_to < on)) I('err', '33', 'CODE_NOT_VALID_ON_DATE', 'varenummeret er ikke gyldig på deklarasjonsdatoen.', 'code');
    }

    const proc = String(it.procedure ?? '');
    if (proc && !/^\d{4}$/.test(proc)) I('err', '37', 'PROC_FORMAT', 'prosedyrekoden har fire siffer.', 'procedure');
    else if (proc && cx.proceduresLoaded && !cx.procedures[proc]) I('err', '37', 'PROC_NOT_IN_TVINN', `prosedyrekode ${proc} finnes ikke i TVINN.`, 'procedure');

    const q = String(it.quota ?? '').trim();
    if (q) {
      const qq = cx.quotas[q];
      if (!qq) I('err', '39', 'QUOTA_UNKNOWN', `tollkvote ${q} finnes ikke.`, 'quota');
      else if (code && !qq.codes.includes(code)) I('err', '39', 'QUOTA_CODE', `varenummeret er ikke omfattet av tollkvote ${q}.`, 'quota');
      else if (!inForce(qq, on)) I('err', '39', 'QUOTA_PERIOD', `tollkvote ${q} gjelder ${qq.valid_from ?? ''}–${qq.valid_to ?? ''}.`, 'quota');
    }

    // Box 36: the rate itself is resolved in phase 2b; here only the proof of origin.
    const pref = String(it.preference ?? '').toUpperCase();
    if (PREF_CLAIM_CODES.includes(pref) && !docs.some(x => PREF_PROOF_DOCS.includes(String(x.code).toUpperCase())))
      I('warn', '36', 'PREF_NO_PROOF', `preferansekode ${pref} kreves, men opprinnelsesbevis (SER) er ikke ført i rubrikk 44.`, 'preference');

    if (code && cx.chedCodes.includes(code) && !docs.some(x => CHED_DOCS.includes(String(x.code).toUpperCase()) && !blank(x.ref)))
      I('warn', '44', 'CHED_MISSING', 'varenummeret krever CHED, men rubrikk 44 har ingen VT-linje med CHED-referanse.', 'docs');

    for (const x of Array.isArray(it.docs) ? it.docs : []) {
      if (blank(x.ref)) I('err', '44', 'ITEM_DOC_NO_REF', `rubrikk 44-kode ${x.code} mangler referanse.`, 'docs');
      if (x.valid && x.valid < on) I('err', '44', 'ITEM_DOC_EXPIRED', `rubrikk 44 ${x.code} ${x.ref ?? ''} utløp ${x.valid} (før deklarasjonsdatoen).`, 'docs');
    }

    if (it.product_id) {
      const p = cx.products[it.product_id];
      if (p && p.status !== 'CHECKED')
        I(p.status === 'BLOCKED' || p.status === 'EXPIRED' ? 'err' : 'warn', '33', 'PRODUCT_NOT_CHECKED', `produkt ${p.product_no} er ikke kontrollert i produktregisteret (${p.status}).`, 'product_id');
    }
    const key = [it.product_id || it.gtin || it.article_no || it.description, it.code, it.price, it.packages].join('|');
    if (it.description && seen.has(key)) I('warn', '32', 'DUPLICATE_LINE', `mulig duplikat av varepost ${seen.get(key)}.`);
    else seen.set(key, n);
  }

  /* ---------------- box 44, shipment-wide ---------------- */
  if (!declDocs.length) add('err', '44', 'NO_DOCS', 'Rubrikk 44 må minst inneholde handelsfaktura (N380).', { field: 'docs' });
  else if (!declDocs.some(x => x.code === 'N380')) add('warn', '44', 'NO_INVOICE', 'Ingen handelsfaktura (N380) i rubrikk 44.', { field: 'docs' });
  for (const x of declDocs) if (!(x.code in DECL_DOC_CODES) && blank(x.ref)) add('err', '44', 'DOC_NO_REF', `Rubrikk 44-kode ${x.code} mangler referanse.`, { field: 'docs' });

  /* ---------------- box 22: value against the goods ---------------- */
  if (!blank(d.invoice_total) && items.length) {
    const sum = items.reduce((a, it) => a + num(it.price), 0);
    const diff = Math.abs(num(d.invoice_total) - sum);
    const nf = (x: number) => x.toFixed(2).replace('.', ',');
    if (diff > 0.5) add('warn', '22', 'VALUE_MISMATCH', `Rubrikk 22 (${nf(num(d.invoice_total))}) avviker fra summen av varenes pris (${nf(sum)}) med ${nf(diff)}.`, { field: 'invoice_total' });
  }

  /* ---------------- box 54: declaration date (TVINN 9017 / 9018) ---------------- */
  if (!blank(d.decl_date)) {
    if (!date) add('err', '54', 'DATE_FORMAT', 'Rubrikk 54 må være en dato.', { field: 'decl_date' });
    else {
      const age = days(date, cx.today);
      if (age > 365) add('err', '54', 'DATE_OLDER_365', `Deklarasjonsdatoen er ${age} dager gammel. TVINN avviser deklarasjonsdato eldre enn 365 dager (9017).`, { field: 'decl_date' });
      else if (age > 90) add('err', '54', 'DATE_OLDER_90', `Deklarasjonsdatoen er ${age} dager gammel. TVINN avviser deklarasjonsdato eldre enn 90 dager (9018).`, { field: 'decl_date' });
      else if (age > 0) add('warn', '54', 'DATE_PAST', 'Deklarasjonsdatoen er passert — den skal være forventet dato for grensepassering.', { field: 'decl_date' });
      if (age < -5) add('warn', '54', 'DATE_TOO_EARLY', 'En Digitoll-sending kan deklareres høyst fem dager før grensepassering.', { field: 'decl_date' });
      if (!blank(d.currency) && cx.currencyKnown && !cx.fxFound)
        add('warn', '22a', 'NO_FX', `Ingen publisert tollkurs for ${d.currency} på ${date}.`, { field: 'currency' });
    }
  }

  /* ---------------- box 48: payment and credit account (TVINN 9110) ---------------- */
  const method = d.payment_method;
  if (method && method !== 'KONTANT') {
    const acct = String(d.payment_account ?? '').replace(/\D/g, '');
    const label = method === 'TOLLKREDITT' ? 'tollkreditt' : 'dagsoppgjør';
    if (blank(d.payment_account)) add('err', '48', 'ACCOUNT_REQUIRED', `Rubrikk 48: velg konto for ${label}.`, { field: 'payment_account' });
    else if (!/^\d{6}$/.test(acct)) add('warn', '48', 'ACCOUNT_FORMAT', 'Rubrikk 48: kontoen skal være et sekssifret nummer.', { field: 'payment_account' });
    else if (!cx.credit) add('err', '48', 'CREDIT_UNKNOWN', `Kredittkonto ${acct} er ikke registrert. TVINN avviser med 9110 når deklaranten ikke har den oppgitte avtalen.`, { field: 'payment_account' });
    else {
      if (cx.credit.status !== 'ACTIVE') add('err', '48', 'CREDIT_INACTIVE', `Kredittkonto ${acct} er ikke aktiv.`, { field: 'payment_account' });
      else if (cx.credit.valid_to && cx.credit.valid_to < cx.today) add('err', '48', 'CREDIT_EXPIRED', `Kredittavtale ${acct} utløp ${cx.credit.valid_to}.`, { field: 'payment_account' });
      if (cx.credit.payment_type !== method)
        add('warn', '48', 'ACCOUNT_TYPE', `Rubrikk 48: konto ${acct} er registrert for ${cx.credit.payment_type === 'TOLLKREDITT' ? 'tollkreditt' : 'dagsoppgjør'}, ikke ${label}.`, { field: 'payment_method' });
    }
  }

  /* ---------------- temporary import (box 1 = 5) ---------------- */
  if (d.decl_type === '5') {
    if (/^01$/.test(String(d.transaction_type ?? '')))
      add('warn', '24', 'TEMP_TRANSACTION', 'Rubrikk 24: 01 (kjøp mot vederlag) passer ikke for midlertidig innførsel. Velg f.eks. 04, 06 eller 09.', { field: 'transaction_type' });
    const wrong = items.filter(it => it.procedure && !String(it.procedure).startsWith('5')).map(it => Number(it.line_no));
    if (wrong.length) add('warn', '37', 'TEMP_PROCEDURE', `Rubrikk 37: varepost ${list(wrong)} har en prosedyre som ikke er midlertidig innførsel. Velg en 5xxx-prosedyre (f.eks. 5000).`);
    const noTxt = items.filter(it => !(Array.isArray(it.docs) ? it.docs : []).some((x: any) => String(x.code).toUpperCase() === 'TXT')).map(it => Number(it.line_no));
    if (items.length && noTxt.length) add('warn', '44', 'TEMP_TXT', `Rubrikk 44: varepost ${list(noTxt)} mangler TXT med formål/hjemmel for midlertidig innførsel.`);
    if (blank(d.reexport_deadline)) add('err', 'B', 'REEXPORT_DEADLINE_MISSING', 'Midlertidig innførsel krever en gjenutførselsfrist.', { field: 'reexport_deadline' });
    else if (date && d.reexport_deadline <= date) add('err', 'B', 'REEXPORT_DEADLINE', 'Gjenutførselsfristen må være etter deklarasjonsdatoen.', { field: 'reexport_deadline' });
  } else if (d.decl_type === '4') {
    const temp = items.filter(it => String(it.procedure ?? '').startsWith('5')).map(it => Number(it.line_no));
    if (temp.length) add('warn', '37', 'PROC_NOT_BOX1', `Rubrikk 37: varepost ${list(temp)} har midlertidig innførsel (5xxx), men rubrikk 1 er 4 (fri disponering). Kontroller rubrikk 1.`);
  }

  if (cx.calc) calcRules(cx, cx.calc, add);
  if (cx.openReviews) add('warn', 'AI', 'REVIEW_OPEN', `${cx.openReviews} kontrollpunkt${cx.openReviews === 1 ? '' : 'er'} fra AI-lesingen er ikke avklart. Alle må avklares før innsending.`);
  return out;
}

const kr = (n: number) => n.toLocaleString('nb-NO', { maximumFractionDigits: 2 });
const rateText = (n: number | null) => (n == null ? '—' : n.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));

/** Rules on the calculation: preference, RT100, levies, box 12, payment (ODIN LINK validation.js, rt.js, saeravgift.js, box12.js). */
function calcRules(cx: RuleContext, calc: DeclCalc, add: (lvl: Level, box: string, rule: string, msg: string, extra?: Partial<Issue>) => void) {
  const d = cx.decl;
  if (!calc.levyDataLoaded && cx.items.length)
    add('warn', '47', 'LEVY_DATA_MISSING', 'Avgiftsdata (MVA, forskningsavgift, særavgifter) er ikke lastet. MVA er beregnet med 25 % og forskningsavgift er ikke tatt med. Oppdater «Avgifter ved innførsel» under Referansedata.');
  for (const l of calc.lines) {
    const it = cx.items.find(x => Number(x.line_no) === l.line_no) ?? {};
    const n = l.line_no;
    const I = (lvl: Level, box: string, rule: string, msg: string, field?: string) => add(lvl, box, rule, `Varepost ${n}: ${msg}`, { item: n, field });
    const docs: any[] = [...(Array.isArray(it.docs) ? it.docs : []), ...(Array.isArray(d.docs) ? d.docs : [])];
    if (!l.code) continue;
    const pref = String(it.preference ?? '').toUpperCase();

    /* Box 36: a claimed preference needs a real preferential rate for the origin. */
    if (PREF_CLAIM_CODES.includes(pref) && l.tl1.source === 'ORDINARY_NO_PREFERENCE_RATE')
      I('err', '36', 'PREF_NO_AGREEMENT', `preferansekode ${pref} kreves, men det finnes ingen preferansesats for opprinnelse ${it.origin || '—'} på varenummer ${l.code}.`, 'preference');
    if (l.unclaimedPref && docs.some(x => ['SER', 'U045'].includes(String(x.code).toUpperCase())) && (l.tl1.rate ?? 0) > l.unclaimedPref.rate)
      I('warn', '36', 'PREF_UNCLAIMED', `opprinnelse ${it.origin} har opprinnelsesbevis og en lavere preferansesats (${l.unclaimedPref.landgruppe}) — tollen kan muligens reduseres (rubrikk 36 er ${pref || 'tom'}).`, 'preference');
    if (l.tl1.source === 'NO_RATE') I('warn', '47', 'RATE_UNRESOLVED', `ingen tollsats funnet for ${l.code} — tollen (A00) er ikke beregnet.`, 'code');
    if (l.tl1.manual) I('warn', '47', 'SPECIFIC_NOT_KG', `tollen er spesifikk, men angitt i ${l.tl1.unitText || 'en annen enhet enn kg'}. Den beregnes ikke automatisk; kontroller manuelt.`, 'code');

    /* RT100. */
    const rt = l.rt;
    if (rt) {
      const name = rt.permit?.product_name ?? '';
      if (rt.status === 'MISSING')
        I('err', '47', 'RT_MISSING', `varenummer ${l.code} har RT100 råvaretollavgift, men ingen tillatelse ble funnet for produktet${rt.sentinel ? ', og Tolletaten publiserer bare en plassholdersats. Vedtak om nedsatt sats fra Landbruksdirektoratet kreves' : ''}.`, 'product_id');
      if (rt.sentinel && rt.variant) I('err', '47', 'RT_RATE_PLACEHOLDER', `${rt.variant}-satsen på RT-tillatelsen for ${name} er en plassholderverdi, ikke en reell sats. Rett tillatelsen etter vedtaksbrevet.`, 'product_id');
      const ps = rt.status === 'PUBLISHED_RATE' || rt.status === 'MISSING' ? rt.permitStatus : rt.status;
      if (ps === 'EXPIRED') I('err', '47', 'RT_EXPIRED', `RT-tillatelsen for ${name} utløp ${rt.permit?.valid_to}. Nytt vedtak fra Landbruksdirektoratet kreves.`, 'product_id');
      if (ps === 'NOT_YET_VALID') I('err', '47', 'RT_NOT_YET_VALID', `RT-tillatelsen for ${name} gjelder fra ${rt.permit?.valid_from}, etter deklarasjonsdatoen.`, 'product_id');
      if (ps === 'EXPIRING') I('warn', '47', 'RT_EXPIRING', `RT-tillatelsen for ${name} utløper ${rt.permit?.valid_to}. Start fornyelsen nå.`, 'product_id');
      if (rt.holder === 'MISMATCH') I('err', '47', 'RT_HOLDER_MISMATCH', `RT-tillatelsen for ${name} innehas av en annen virksomhet enn importøren i rubrikk 8. En nedsatt sats gis til en navngitt virksomhet og kan ikke overdras.`, 'product_id');
      if (rt.holder === 'UNRECORDED') I('warn', '47', 'RT_HOLDER_UNRECORDED', `RT-tillatelsen for ${name} mangler innehaverens organisasjonsnummer. Før det inn fra vedtaksbrevet.`, 'product_id');
      if (rt.holder === 'NO_IMPORTER_ORG') I('warn', '8', 'RT_IMPORTER_NO_ORG', 'importøren i rubrikk 8 har ikke organisasjonsnummer, så innehaveren av RT-tillatelsen kan ikke kontrolleres.', 'product_id');
      if (rt.variant && !rt.confident) I('warn', '47', 'RT_VARIANT_UNCERTAIN', `opprinnelsen bestemmer ikke RT-satsvarianten. Den høyeste satsen (${rt.variant} ${rateText(rt.rate)}) er brukt — kontroller mot vedtaksbrevet.`, 'origin');
      if (rt.status === 'PUBLISHED_RATE' && rt.amount > 0) {
        const usk = docs.find(x => String(x.code).toUpperCase() === 'USK');
        I('warn', '47', usk ? 'RT_USK_NOT_REGISTERED' : 'RT_FULL_RATE', usk
          ? `rubrikk 44 viser USK ${usk.ref ?? ''}, men vedtaket er ikke registrert på produktet. RT100 er beregnet med full sats ${rateText(rt.rate)} kr/kg = ${kr(rt.amount)} kr. Registrer RT-tillatelsen på produktet.`
          : `RT100 er beregnet med full publisert sats ${rateText(rt.rate)} kr/kg = ${kr(rt.amount)} kr. Har importøren vedtak om nedsatt sats (USK), registrer det som RT-tillatelse på produktet.`, 'product_id');
      }
      if (['VALID', 'EXPIRING', 'PUBLISHED_RATE'].includes(rt.status) && !(Number(it.net_kg) > 0))
        I('err', '38', 'RT_NO_NET_MASS', 'RT100 beregnes per kilo, så nettovekten i rubrikk 38 må være større enn null.', 'net_kg');
    }

    /* Excise duties: a choice (group and quantity, or not applicable) per levy type on the code. */
    const chosen: any[] = Array.isArray(it.levies) ? it.levies : [];
    for (const t of l.levyTypes) {
      const c = chosen.find(x => x?.type === t.type);
      if (!c || c.group == null || c.group === '') I('warn', '47', 'LEVY_CHOICE', `varenummeret har ${t.type} (${t.text ?? ''}). Velg avgiftsgruppe og mengde, eller «Gjelder ikke».`, 'levies');
      else if (c.group !== 'NA') {
        const g = t.groups.find(x => x.group === String(c.group));
        if (!g) I('err', '47', 'LEVY_GROUP', `${t.type}: avgiftsgruppe ${c.group} finnes ikke for varenummeret på deklarasjonsdatoen.`, 'levies');
        else if (g.unit !== 'P' && !(Number(c.qty) > 0)) I('err', '47', 'LEVY_QTY', `${t.type} ${g.text ?? ''}: oppgi mengde (${(g.unitText ?? g.unit ?? '').toLowerCase()}).`, 'levies');
      }
    }
    if (l.tillegg) I('info', '47', 'ADDITIONAL_DUTY', `tilleggstollavgift ${rateText(l.tillegg.rate)} ${l.tillegg.unit === 'P' ? '%' : 'kr/kg'} for opprinnelse ${it.origin} (landgruppe ${l.tillegg.landgruppe}).`, 'origin');
    if (calc.levyDataLoaded && l.vat.amount === null) I('warn', '47', 'VAT_UNRESOLVED', 'ingen MVA-sats funnet for varenummeret.', 'code');
  }

  /* Box 12. */
  const b12: any[] = Array.isArray(d.value_details) ? d.value_details : [];
  b12.forEach((x, i) => {
    const n = i + 1;
    if (!x || !(x.kind in B12_TYPES)) add('err', '12', 'B12_KIND', `Rubrikk 12, linje ${n}: velg tillegg eller fradrag.`, { field: 'value_details' });
    else if (!(x.type in B12_TYPES[x.kind as 'ADD' | 'DED'])) add('err', '12', 'B12_TYPE', `Rubrikk 12, linje ${n}: velg type.`, { field: 'value_details' });
    if (!(Number(x?.amount) > 0)) add('err', '12', 'B12_AMOUNT', `Rubrikk 12, linje ${n}: beløpet må være større enn null.`, { field: 'value_details' });
    if (x?.basis && !(x.basis in B12_BASES)) add('err', '12', 'B12_BASIS', `Rubrikk 12, linje ${n}: ukjent fordelingsnøkkel.`, { field: 'value_details' });
    if (x?.type === 'ANDRE' && !String(x.text ?? '').trim()) add('warn', '12', 'B12_TEXT', `Rubrikk 12, linje ${n}: beskriv hva tillegget eller fradraget gjelder.`, { field: 'value_details' });
  });
  const a = calc.box12;
  if (a.active && cx.items.length) {
    if (a.bases.includes('VALUE') && !(a.valueTotal > 0)) add('err', '12', 'B12_NO_BASIS', 'Rubrikk 12 kan ikke fordeles: vareverdien (rubrikk 42) er null.', { field: 'value_details' });
    if (a.bases.includes('GROSS') && !(a.grossTotal > 0)) add('err', '12', 'B12_NO_GROSS', 'Rubrikk 12 skal fordeles etter bruttovekt, men ingen vareposter har bruttovekt (rubrikk 35).', { field: 'value_details' });
    if (a.bases.includes('NET') && !(a.netTotal > 0)) add('err', '12', 'B12_NO_NET', 'Rubrikk 12 skal fordeles etter nettovekt, men ingen vareposter har nettovekt (rubrikk 38).', { field: 'value_details' });
    if (a.dedTotal > 0 && a.dedTotal >= a.valueTotal + a.addTotal) add('err', '12', 'B12_DED_TOO_LARGE', 'Rubrikk 12: fradragene er like store som eller større enn vareverdien med tillegg.', { field: 'value_details' });
    const manual = cx.items.filter(it => Number(it.freight) > 0 || Number(it.add_amount) > 0 || Number(it.ded_amount) > 0).map(it => Number(it.line_no));
    if (manual.length) add('warn', '45', 'B12_OVERRIDES_ITEM', `Rubrikk 12 er fylt ut og fordeles på alle vareposter; tillegg og fradrag ført på varepost ${list(manual)} brukes ikke.`);
  }

  /* Box 48: something to pay needs a payment method. */
  if (calc.payable > 0 && !d.payment_method)
    add('err', '48', 'PAYMENT_REQUIRED', `Toll og avgifter på ${kr(calc.payable)} kr skal betales — betalingsmåte må oppgis i rubrikk 48.`, { field: 'payment_method' });
}

export const summary = (issues: Issue[]) => ({
  ok: !issues.some(i => i.lvl === 'err'),
  errors: issues.filter(i => i.lvl === 'err').length,
  warnings: issues.filter(i => i.lvl === 'warn').length
});
