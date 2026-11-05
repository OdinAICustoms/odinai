import type { Request } from 'express';
import { one, query, tx, pool, type Db } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as docs from '../documents.js';
import * as L from '../refdata/lookup.js';
import * as C from './codes.js';
import { check, summary, type PartyInfo, type RuleContext } from './rules.js';
import { calculate, B12_TYPES, B12_BASES, type CalcContext } from './calc.js';
import * as AI from '../ai/intake.js';

/**
 * Import declarations: the header (SAD boxes as columns) and its goods items. Only a DRAFT or RETURNED
 * declaration can be changed; every change bumps the version (so a second user gets "changed by someone
 * else" instead of overwriting) and is written to the audit log field by field.
 */
const today = () => new Date().toISOString().slice(0, 10);
const who = (req: Request) => req.user!.id;
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const isUuid = (v: unknown) => /^[0-9a-f-]{36}$/i.test(String(v ?? ''));

/* ------------------------------ input cleaning ------------------------------ */
type Kind = 'uuid' | 'text' | 'date' | 'num' | 'int' | 'bool' | 'docs' | 'levies' | 'box12' |{ enum: string[] } | { re: RegExp; msg: string; upper?: boolean; digits?: boolean };
const country = { re: /^[A-Z]{2}$/, msg: 'må være en landkode med to bokstaver', upper: true };
const HEADER: Record<string, Kind> = {
  client_id: 'uuid', exporter_id: 'uuid', importer_id: 'uuid', declarant_id: 'uuid',
  own_ref: 'text', decl_type: { enum: Object.keys(C.DECL_TYPES) }, office: { re: /^\d{6}$/, msg: 'må ha seks siffer', digits: true },
  decl_date: 'date', place: 'text', dispatch_country: country, transport_id: 'text', transport_nat: country,
  container: 'bool', container_nos: 'text', transport_mode: { enum: Object.keys(C.TRANSPORT_MODES) },
  incoterms: { enum: C.INCOTERMS }, incoterms_place: 'text', invoice_total: 'num', currency: { re: /^[A-Z]{3}$/, msg: 'må være en valutakode med tre bokstaver', upper: true },
  transaction_type: { enum: Object.keys(C.TRANSACTION_TYPES) }, goods_location: 'text', prev_doc: 'text', warehouse_id: 'text',
  reexport_deadline: 'date', payment_method: { enum: Object.keys(C.PAYMENT_METHODS) }, payment_account: 'text', docs: 'docs', notes: 'text',
  value_details: 'box12'
};
const ITEM: Record<string, Kind> = {
  product_id: 'uuid', description: 'text', packages: 'int', package_kind: 'text', marks: 'text',
  code: { re: /^\d{8}$/, msg: 'må ha 8 siffer', digits: true }, origin: country, preference: { enum: Object.keys(C.PREFERENCES) },
  procedure: { re: /^\d{4}$/, msg: 'har fire siffer', digits: true }, nat_procedure: 'text', quota: 'text',
  gross_kg: 'num', net_kg: 'num', supp_qty: 'num', price: 'num', valuation_method: { enum: Object.keys(C.VALUATION_METHODS) },
  freight: 'num', add_amount: 'num', ded_amount: 'num', docs: 'docs', article_no: 'text', gtin: 'text', levies: 'levies'
};
const JSON_COLS = new Set(['docs', 'source', 'levies', 'value_details']);
const jsonOr = (k: string, v: unknown) => (JSON_COLS.has(k) ? JSON.stringify(v) : v);
const LABEL: Record<string, string> = {
  office: 'Rubrikk A', dispatch_country: 'Rubrikk 15', transport_nat: 'Rubrikk 21', currency: 'Rubrikk 22a', code: 'Rubrikk 33',
  origin: 'Rubrikk 34', procedure: 'Rubrikk 37', invoice_total: 'Rubrikk 22', price: 'Rubrikk 42', net_kg: 'Rubrikk 38', gross_kg: 'Rubrikk 35'
};

function cleanDocs(v: unknown) {
  if (v == null) return [];
  if (!Array.isArray(v)) fail(400, 'Rubrikk 44 må være en liste.');
  return (v as any[]).map(x => {
    const code = str(x?.code)?.toUpperCase();
    if (!code || !/^[A-Z0-9]{2,5}$/.test(code)) fail(400, 'Rubrikk 44: ugyldig dokumentkode.');
    const date = (k: string) => (str(x[k]) && /^\d{4}-\d{2}-\d{2}/.test(String(x[k])) ? String(x[k]).slice(0, 10) : null);
    const o: Record<string, unknown> = { code, ref: str(x.ref) };
    if (date('date')) o.date = date('date');
    if (date('valid')) o.valid = date('valid');
    if (str(x.document_id) && isUuid(x.document_id)) o.document_id = String(x.document_id);
    return o;
  });
}

/** Excise choices on a goods item: [{type, group | 'NA', qty}]. */
function cleanLevies(v: unknown) {
  if (v == null) return [];
  if (!Array.isArray(v)) fail(400, 'Avgiftsvalg må være en liste.');
  return (v as any[]).filter(x => str(x?.type)).map(x => {
    const group = str(x.group);
    const qty = str(x.qty) == null ? null : Number(String(x.qty).replace(/\s/g, '').replace(',', '.'));
    if (qty != null && (!Number.isFinite(qty) || qty < 0)) fail(400, 'Avgiftsmengden må være et tall som er null eller større.');
    return { type: String(x.type).toUpperCase().slice(0, 4), group: group ? group.toUpperCase().slice(0, 10) : null, qty };
  });
}
/** Box 12 lines: [{kind, type, amount, currency, basis, text}]. */
function cleanBox12(v: unknown) {
  if (v == null) return [];
  if (!Array.isArray(v)) fail(400, 'Rubrikk 12 må være en liste.');
  return (v as any[]).map(x => {
    const amount = Number(String(x?.amount ?? '').replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) fail(400, 'Rubrikk 12: beløpet må være et tall som er null eller større.');
    const kind = String(x?.kind ?? '').toUpperCase();
    if (kind !== 'ADD' && kind !== 'DED') fail(400, 'Rubrikk 12: velg tillegg eller fradrag.');
    return { kind, type: String(x.type ?? '').toUpperCase(), amount, currency: String(x.currency ?? 'INV').toUpperCase() === 'NOK' ? 'NOK' : 'INV',
      basis: ['GROSS', 'NET', 'VALUE'].includes(String(x.basis ?? '').toUpperCase()) ? String(x.basis).toUpperCase() : (['FRAKT', 'FRAKT_INNLAND'].includes(String(x.type ?? '').toUpperCase()) ? 'GROSS' : 'VALUE'),
      text: str(x.text) };
  });
}

function clean(b: any, spec: Record<string, Kind>) {
  const o: Record<string, any> = {};
  for (const [k, kind] of Object.entries(spec)) {
    if (b[k] === undefined) continue;
    const v = b[k], s = str(v), label = LABEL[k] ?? k;
    if (kind === 'docs') { o[k] = cleanDocs(v); continue; }
    if (kind === 'levies') { o[k] = cleanLevies(v); continue; }
    if (kind === 'box12') { o[k] = cleanBox12(v); continue; }
    if (kind === 'bool') { o[k] = v === true || v === 'true' || v === 1; continue; }
    if (s == null) { o[k] = null; continue; }
    if (kind === 'text') o[k] = s.slice(0, 500);
    else if (kind === 'uuid') { if (!isUuid(s)) fail(400, `Ugyldig verdi for ${k}.`); o[k] = s; }
    else if (kind === 'date') { if (!/^\d{4}-\d{2}-\d{2}/.test(s)) fail(400, `${label}: ugyldig dato.`); o[k] = s.slice(0, 10); }
    else if (kind === 'num' || kind === 'int') {
      const n = Number(s.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) fail(400, `${label}: må være et tall som er null eller større.`);
      if (kind === 'int' && !Number.isInteger(n)) fail(400, `${label}: må være et helt tall.`);
      o[k] = n;
    } else if ('enum' in kind) { const u = s.toUpperCase(); if (!kind.enum.includes(u) && !kind.enum.includes(s)) fail(400, `${label}: ukjent verdi «${s}».`); o[k] = kind.enum.includes(u) ? u : s; }
    else {
      const x = kind.digits ? s.replace(/\D/g, '') : kind.upper ? s.toUpperCase() : s;
      if (!kind.re.test(x)) fail(400, `${label} ${kind.msg}.`, 'FORMAT');
      o[k] = x;
    }
  }
  return o;
}
/** Same value as stored? Numerics arrive from pg as strings ("12.50"), dates as "YYYY-MM-DD". */
const same = (stored: unknown, next: unknown) => {
  if (stored == null || next == null) return stored == null && next == null;
  if (typeof next === 'number') return Number(stored) === next;
  if (typeof next === 'object') return JSON.stringify(stored) === JSON.stringify(next);
  return String(stored) === String(next);
};

/* ------------------------------ reading ------------------------------ */
async function requireDecl(id: string, db: Db = pool) {
  if (!isUuid(id)) fail(404, 'Fant ikke deklarasjonen.');
  const d = await one('SELECT * FROM declaration WHERE id = $1', [id], db);
  if (!d) fail(404, 'Fant ikke deklarasjonen.');
  return d!;
}
const items = (id: string, db: Db = pool) => query(`SELECT i.*, p.product_no, p.status product_status, t.text tariff_text, t.supp_unit tariff_supp_unit
    FROM declaration_item i LEFT JOIN product p ON p.id = i.product_id LEFT JOIN tariff t ON t.code = i.code
    WHERE i.declaration_id = $1 ORDER BY i.line_no`, [id], db);

export async function card(id: string) {
  const d = await requireDecl(id);
  const its = await items(id);
  const party = async (pid: string | null) => (pid ? one(`SELECT b.id, b.partner_no, b.legal_name, b.registration_country,
      (SELECT identifier_value FROM bp_identifier i WHERE i.partner_id = b.id AND i.identifier_type IN ('ORG_NO', 'EORI') AND i.status = 'ACTIVE'
        ORDER BY (i.identifier_type = 'ORG_NO') DESC LIMIT 1) identifier
      FROM business_partner b WHERE b.id = $1`, [pid]) : null);
  const [client, exporter, importer, declarant] = await Promise.all([party(d.client_id), party(d.exporter_id), party(d.importer_id), party(d.declarant_id)]);
  const users = await query('SELECT id, name FROM users WHERE id = ANY($1)', [[d.created_by, d.updated_by].filter(Boolean)]);
  const name = (u: string | null) => users.find(x => x.id === u)?.name ?? null;
  const cx = await context(d, its);
  const issues = check(cx);
  return {
    calc: cx.calc, reviews: await AI.reviewsFor(id), intakes: await AI.intakesFor(id), ai: AI.status(),
    ...d, items: its, parties: { client, exporter, importer, declarant }, box1: C.box1Column1(d.dispatch_country),
    created_by_name: name(d.created_by), updated_by_name: name(d.updated_by),
    editable: C.EDITABLE.includes(d.status), documents: await docs.listFor('DECLARATION', id), issues, check: summary(issues)
  };
}

export async function list(f: Record<string, string | undefined> = {}) {
  const p: unknown[] = [], where = ["d.direction = 'IMPORT'"];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace(/\?/g, `$${p.length}`)); };
  if (f.status) add('d.status = ANY(?)', f.status.split(','));
  else if (f.all !== '1') where.push("d.status <> 'CANCELLED'");
  if (f.client) add('(d.client_id = ? OR d.importer_id = ?)', f.client);
  if (f.mine === '1' && f.user) add('d.created_by = ?', f.user);
  if (f.from) add('d.decl_date >= ?::date', f.from);
  if (f.to) add('d.decl_date <= ?::date', f.to);
  if (f.q) {
    p.push(`%${f.q}%`);
    const x = `$${p.length}`;
    where.push(`(d.decl_no ILIKE ${x} OR d.own_ref ILIKE ${x} OR c.legal_name ILIKE ${x} OR i.legal_name ILIKE ${x} OR e.legal_name ILIKE ${x}
      OR EXISTS (SELECT 1 FROM declaration_item it WHERE it.declaration_id = d.id AND (it.description ILIKE ${x} OR it.code LIKE ${x})))`);
  }
  return query(`SELECT d.id, d.decl_no, d.status, d.decl_date, d.decl_type, d.own_ref, d.currency, d.invoice_total, d.created_from, d.updated_at, d.version,
      c.legal_name client_name, i.legal_name importer_name, e.legal_name exporter_name, u.name updated_by_name,
      (SELECT COUNT(*) FROM declaration_item it WHERE it.declaration_id = d.id) item_count
    FROM declaration d LEFT JOIN business_partner c ON c.id = d.client_id LEFT JOIN business_partner i ON i.id = d.importer_id
    LEFT JOIN business_partner e ON e.id = d.exporter_id LEFT JOIN users u ON u.id = d.updated_by
    WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC LIMIT ${Math.min(Number(f.limit) || 300, 2000)}`, p);
}

/* ------------------------------ rule context ------------------------------ */
async function partyInfo(id: string | null, date: string): Promise<PartyInfo | null> {
  if (!id) return null;
  const b = await one('SELECT id, legal_name, status, registration_country FROM business_partner WHERE id = $1', [id]);
  if (!b) return null;
  const inForce = `(valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date) AND status = 'ACTIVE'`;
  const roles = (await query(`SELECT role_code FROM bp_role WHERE partner_id = $1 AND ${inForce}`, [id, date])).map(r => r.role_code);
  const addr = await one(`SELECT 1 FROM bp_address WHERE partner_id = $1 AND is_standard AND ${inForce}`, [id, date]);
  const ids = await query(`SELECT identifier_type, identifier_value, check_status FROM bp_identifier WHERE partner_id = $1 AND ${inForce}`, [id, date]);
  const reg = await one('SELECT deleted, bankrupt, winding_up, forced_dissolution, vat_registered, fetched_at FROM bp_registry WHERE partner_id = $1', [id]);
  const idOf = (t: string) => ids.find(i => i.identifier_type === t)?.identifier_value ?? null;
  return {
    name: b.legal_name, status: b.status, roles, hasStandardAddress: !!addr, orgNo: idOf('ORG_NO'), personNo: idOf('PERSON_NO'),
    country: b.registration_country, registry: reg ? { ...reg, fetched_at: reg.fetched_at ? new Date(reg.fetched_at).toISOString() : undefined } : null,
    eoriInvalid: ids.find(i => i.identifier_type === 'EORI' && i.check_status === 'INVALID')?.identifier_value ?? null
  };
}

/** Everything the calculation needs for the declaration date (src/declarations/calc.ts). */
export async function calcContext(d: any, its: any[]): Promise<CalcContext> {
  const date = d.decl_date ?? today();
  const codes = [...new Set(its.map(i => i.code).filter(Boolean))] as string[];
  const inForce = `(valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)`;
  const rates: CalcContext['rates'] = {};
  for (const r of await query(`SELECT code, landgruppe, duty_code, rate_value, rate_unit, unit_code, unit_text FROM tariff_rate
      WHERE code = ANY($1) AND ${inForce} ORDER BY valid_from DESC`, [codes, date])) {
    const list = (rates[r.code] ??= []);
    if (!list.some(x => x.landgruppe === r.landgruppe && x.duty_code === r.duty_code)) list.push(r);
  }
  const origins = [...new Set(its.map(i => i.origin).filter(Boolean))] as string[];
  const groupsOf: CalcContext['groupsOf'] = {};
  for (const r of await query(`SELECT country_code, landgruppe FROM landgruppe_country WHERE country_code = ANY($1) AND ${inForce}`, [origins, date]))
    (groupsOf[r.country_code] ??= []).push(r.landgruppe);
  const levies: CalcContext['levies'] = {};
  for (const r of await query(`SELECT code, levy_type, levy_type_text, levy_group, levy_group_text, rate, unit, unit_text FROM ref_import_levy
      WHERE code = ANY($1) AND ${inForce} ORDER BY levy_type, levy_group, valid_from DESC`, [codes, date])) (levies[r.code] ??= []).push(r);
  const additional: CalcContext['additional'] = {};
  for (const r of await query(`SELECT code, landgruppe, rate, unit, unit_text FROM ref_additional_duty WHERE code = ANY($1) AND ${inForce}`, [codes, date]))
    (additional[r.code] ??= []).push(r);
  const permits: CalcContext['permits'] = {};
  for (const r of await query(`SELECT id, product_id, permit_no, product_name, holder_org_no, rate_tall, skriv_tall, rate_toes, skriv_toes, valid_from, valid_to
      FROM rt_permit WHERE product_id = ANY($1) AND active ORDER BY valid_to DESC`, [[...new Set(its.map(i => i.product_id).filter(Boolean))]]))
    (permits[r.product_id] ??= []).push(r);
  const importerOrg = d.importer_id ? (await one(`SELECT replace(identifier_value, ' ', '') v FROM bp_identifier WHERE partner_id = $1 AND identifier_type IN ('ORG_NO', 'EORI')
      AND status = 'ACTIVE' ORDER BY (identifier_type = 'ORG_NO') DESC, is_primary DESC LIMIT 1`, [d.importer_id]))?.v ?? null : null;
  const fx = !d.currency ? null : d.currency === 'NOK' ? 1 : (await L.fxRate(d.currency, date))?.rate;
  return {
    date, currency: d.currency ?? null, fx: fx == null ? null : Number(fx), declType: d.decl_type ?? null, groupsOf, rates, levies,
    levyDataLoaded: !!(await one('SELECT 1 FROM ref_import_levy LIMIT 1')), additional, permits, importerOrg,
    box12: Array.isArray(d.value_details) ? d.value_details : []
  };
}

export async function context(d: any, its: any[]): Promise<RuleContext> {
  const date = d.decl_date ?? today();
  const codes = [...new Set(its.map(i => i.code).filter(Boolean))] as string[];
  const tariffLoaded = await L.loaded('tariff');
  const tariff: RuleContext['tariff'] = {};
  for (const r of await query('SELECT code, level, supp_unit, supp_text, valid_from, valid_to FROM tariff WHERE code = ANY($1)', [codes])) tariff[r.code] = r;
  for (const c of codes) tariff[c] ??= null;
  const codeValidity: RuleContext['codeValidity'] = {};
  for (const r of await query('SELECT code, valid_from, valid_to FROM ref_code_validity WHERE code = ANY($1)', [codes])) (codeValidity[r.code] ??= []).push(r);
  const chedCodes = (await query(`SELECT DISTINCT code FROM restriction WHERE code = ANY($1) AND document_code = 'CHED'
      AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)`, [codes, date])).map(r => r.code);
  const procs = [...new Set(its.map(i => i.procedure).filter(Boolean))];
  const procedures: Record<string, boolean> = {};
  for (const r of await query('SELECT code FROM ref_procedure WHERE code = ANY($1)', [procs])) procedures[r.code] = true;
  const quotas: RuleContext['quotas'] = {};
  for (const q of new Set(its.map(i => String(i.quota ?? '').trim()).filter(Boolean))) quotas[q] = await L.quota(q);
  const productIds = [...new Set(its.map(i => i.product_id).filter(Boolean))];
  const products: RuleContext['products'] = {};
  for (const r of await query('SELECT id, status, product_no FROM product WHERE id = ANY($1)', [productIds])) products[r.id] = r;
  const fullmakt = d.importer_id && d.declarant_id && d.importer_id !== d.declarant_id
    ? await (async () => {
      const rows = await query(`SELECT valid_from, valid_to, scope FROM bp_fullmakt WHERE partner_id = $1 AND representative_id = $2 AND status = 'ACTIVE'
          ORDER BY valid_to DESC NULLS FIRST`, [d.importer_id, d.declarant_id]);
      const valid = rows.find(r => r.valid_from <= date && (!r.valid_to || r.valid_to >= date));
      if (valid) return { valid: true, scope: valid.scope };
      return rows.length ? { valid: false, expiredTo: rows.find(r => r.valid_to && r.valid_to < date)?.valid_to ?? null } : null;
    })()
    : undefined;
  const acct = String(d.payment_account ?? '').replace(/\D/g, '');
  const credit = acct ? await one(`SELECT c.account, c.payment_type, c.status, c.valid_to, b.legal_name partner_name FROM bp_credit_account c
      JOIN business_partner b ON b.id = c.partner_id WHERE c.account = $1 ORDER BY (c.status = 'ACTIVE') DESC LIMIT 1`, [acct]) : null;
  return {
    decl: d, items: its, today: today(),
    parties: { exporter_id: await partyInfo(d.exporter_id, date), importer_id: await partyInfo(d.importer_id, date), declarant_id: await partyInfo(d.declarant_id, date) },
    fullmakt, tariffLoaded, tariff, codeValidity, chedCodes,
    officesLoaded: await L.loaded('ref_office'), office: d.office ? await L.office(d.office) : null,
    proceduresLoaded: await L.loaded('ref_procedure'), procedures, quotas,
    currencyKnown: !d.currency || d.currency === 'NOK' || !!(await one('SELECT 1 FROM currency WHERE code = $1', [d.currency])),
    fxFound: !d.currency || !!(await L.fxRate(d.currency, date)),
    credit, products, calc: calculate(its, await calcContext(d, its)),
    openReviews: d.id ? (await one<{ n: number }>("SELECT COUNT(*) n FROM declaration_review WHERE declaration_id = $1 AND status = 'OPEN'", [d.id]))!.n : 0
  };
}

export async function validate(id: string) {
  const d = await requireDecl(id);
  const issues = check(await context(d, await items(id)));
  return { issues, ...summary(issues) };
}

/* ------------------------------ writing ------------------------------ */
async function requirePartner(id: string | null | undefined, label: string, db: Db = pool) {
  if (id && !(await one('SELECT 1 FROM business_partner WHERE id = $1 AND merged_into IS NULL', [id], db))) fail(400, `${label} finnes ikke i Forretningspartner.`);
}
async function requireProduct(id: string | null | undefined, db: Db = pool) {
  if (!id) return null;
  const p = await one('SELECT * FROM product WHERE id = $1 AND merged_into IS NULL', [id], db);
  if (!p) fail(400, 'Produktet finnes ikke i produktregisteret.');
  return p;
}
function editable(d: any, version?: unknown) {
  if (!C.EDITABLE.includes(d.status)) fail(409, `Deklarasjonen har status ${d.status} og kan ikke endres.`, 'NOT_EDITABLE');
  if (version != null && Number(version) !== d.version) fail(409, 'Deklarasjonen er endret av en annen bruker. Last inn på nytt før du lagrer.', 'VERSION');
}
const bump = (c: Db, id: string, userId: string) =>
  c.query('UPDATE declaration SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [id, userId]);

/** Odin itself for box 14 (found by org. no. in the register) and the place for box 54a, from the settings. */
async function declarantDefaults() {
  const s = (await one<{ value: any }>("SELECT value FROM app_settings WHERE key = 'declarant'"))?.value ?? {};
  const orgNo = String(s.orgNo ?? '').replace(/\D/g, '');
  const p = orgNo ? await one(`SELECT b.id FROM bp_identifier i JOIN business_partner b ON b.id = i.partner_id
      WHERE i.identifier_type = 'ORG_NO' AND replace(i.identifier_value, ' ', '') = $1 AND i.status = 'ACTIVE' AND b.merged_into IS NULL AND b.status = 'ACTIVE' LIMIT 1`, [orgNo]) : null;
  return { declarant_id: p?.id ?? null, place: str(s.place) };
}

/**
 * Fill an item's empty fields from its register product. Never overwrites what is there: neither a value
 * in this save nor one already stored on the item (`stored`).
 */
function fromProduct(o: Record<string, any>, p: any, stored: Record<string, any> = {}) {
  if (!p) return o;
  const fill = (k: string, v: unknown) => { if ((o[k] === undefined || o[k] === null) && stored[k] == null && v != null) o[k] = v; };
  fill('description', p.descr); fill('code', p.code); fill('origin', p.origin);
  return o;
}

async function insertItem(c: Db, declId: string, o: Record<string, any>, lineNo: number) {
  const cols = Object.keys(o);
  const r = await c.query(`INSERT INTO declaration_item (declaration_id, line_no${cols.map(k => ', ' + k).join('')})
      VALUES ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`,
    [declId, lineNo, ...cols.map(k => jsonOr(k, o[k]))]);
  return r.rows[0].id as string;
}

export async function create(req: Request, b: any = {}, from = 'MANUAL') {
  const o = clean(b, HEADER);
  const def = await declarantDefaults();
  o.declarant_id ??= def.declarant_id;
  o.place ??= def.place;
  o.decl_type ??= '4';
  o.decl_date ??= today();
  o.transaction_type ??= '01';
  o.client_id ??= o.importer_id ?? null;
  for (const [k, label] of [['client_id', 'Klienten'], ['exporter_id', 'Avsenderen'], ['importer_id', 'Mottakeren'], ['declarant_id', 'Deklaranten']] as const)
    await requirePartner(o[k], label);
  const lines = Array.isArray(b.items) ? b.items.map((x: any) => clean(x, ITEM)) : [];
  const id = await tx(async c => {
    const cols = Object.keys(o);
    const d = (await c.query(`INSERT INTO declaration (created_from, created_by, updated_by${cols.map(k => ', ' + k).join('')})
        VALUES ($1, $2, $2${cols.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id, decl_no`,
      [from, who(req), ...cols.map(k => jsonOr(k, o[k]))])).rows[0];
    let n = 0;
    for (const l of lines) await insertItem(c, d.id, fromProduct(l, await requireProduct(l.product_id, c)), ++n);
    await audit(req, { action: 'DECLARATION_CREATED', objectType: 'DECLARATION', objectId: d.id, after: o, detail: { declNo: d.decl_no, from, items: n } }, c);
    return d.id as string;
  });
  return card(id);
}

export async function update(req: Request, id: string, b: any) {
  const d = await requireDecl(id);
  editable(d, b.version);
  const o = clean(b, HEADER);
  for (const [k, label] of [['client_id', 'Klienten'], ['exporter_id', 'Avsenderen'], ['importer_id', 'Mottakeren'], ['declarant_id', 'Deklaranten']] as const)
    if (k in o) await requirePartner(o[k], label);
  const changes = Object.entries(o).filter(([k, v]) => !same(d[k], v));
  if (!changes.length) return card(id);
  await tx(async c => {
    const set = changes.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    await c.query(`UPDATE declaration SET ${set}, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [id, who(req), ...changes.map(([k, v]) => jsonOr(k, v))]);
    await audit(req, { action: 'DECLARATION_CHANGED', objectType: 'DECLARATION', objectId: id,
      before: Object.fromEntries(changes.map(([k]) => [k, d[k]])), after: Object.fromEntries(changes) }, c);
  });
  return card(id);
}

export async function addItem(req: Request, id: string, b: any) {
  const d = await requireDecl(id);
  editable(d, b.version);
  const o = clean(b, ITEM);
  await tx(async c => {
    const next = (await c.query('SELECT coalesce(MAX(line_no), 0) + 1 n FROM declaration_item WHERE declaration_id = $1', [id])).rows[0].n;
    const itemId = await insertItem(c, id, fromProduct(o, await requireProduct(o.product_id, c)), Number(next));
    await bump(c, id, who(req));
    await audit(req, { action: 'DECLARATION_ITEM_ADDED', objectType: 'DECLARATION', objectId: id, after: o, detail: { item: itemId, line: Number(next) } }, c);
  });
  return card(id);
}

async function requireItem(declId: string, itemId: string, db: Db = pool) {
  if (!isUuid(itemId)) fail(404, 'Fant ikke vareposten.');
  const it = await one('SELECT * FROM declaration_item WHERE id = $1 AND declaration_id = $2', [itemId, declId], db);
  if (!it) fail(404, 'Fant ikke vareposten.');
  return it!;
}

export async function updateItem(req: Request, id: string, itemId: string, b: any) {
  const d = await requireDecl(id);
  editable(d, b.version);
  const it = await requireItem(id, itemId);
  const o = clean(b, ITEM);
  if (o.product_id && o.product_id !== it.product_id) fromProduct(o, await requireProduct(o.product_id), it);
  const changes = Object.entries(o).filter(([k, v]) => !same(it[k], v));
  if (!changes.length) return card(id);
  await tx(async c => {
    await c.query(`UPDATE declaration_item SET ${changes.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [itemId, ...changes.map(([k, v]) => jsonOr(k, v))]);
    await bump(c, id, who(req));
    await audit(req, { action: 'DECLARATION_ITEM_CHANGED', objectType: 'DECLARATION', objectId: id,
      before: Object.fromEntries(changes.map(([k]) => [k, it[k]])), after: Object.fromEntries(changes), detail: { item: itemId, line: it.line_no } }, c);
  });
  return card(id);
}

/** Remove a goods item from a draft; the remaining items are numbered 1, 2, 3 ... again. */
export async function removeItem(req: Request, id: string, itemId: string, version?: unknown) {
  const d = await requireDecl(id);
  editable(d, version);
  const it = await requireItem(id, itemId);
  await tx(async c => {
    await c.query('DELETE FROM declaration_item WHERE id = $1', [itemId]);
    await c.query(`UPDATE declaration_item SET line_no = x.n FROM (SELECT id, row_number() OVER (ORDER BY line_no) n FROM declaration_item WHERE declaration_id = $1) x
        WHERE declaration_item.id = x.id`, [id]);
    await bump(c, id, who(req));
    const { id: _i, declaration_id: _d, ...kept } = it;
    await audit(req, { action: 'DECLARATION_ITEM_REMOVED', objectType: 'DECLARATION', objectId: id, before: kept, detail: { item: itemId, line: it.line_no } }, c);
  });
  return card(id);
}

/** Move an item to another position (1-based); the others shift. */
export async function moveItem(req: Request, id: string, itemId: string, to: number, version?: unknown) {
  const d = await requireDecl(id);
  editable(d, version);
  const it = await requireItem(id, itemId);
  const ids = (await query('SELECT id FROM declaration_item WHERE declaration_id = $1 ORDER BY line_no', [id])).map(r => r.id as string);
  const target = Math.max(1, Math.min(ids.length, Math.trunc(Number(to) || 1)));
  if (target === it.line_no) return card(id);
  ids.splice(ids.indexOf(itemId), 1);
  ids.splice(target - 1, 0, itemId);
  await tx(async c => {
    for (const [i, x] of ids.entries()) await c.query('UPDATE declaration_item SET line_no = $2 WHERE id = $1', [x, i + 1]);
    await bump(c, id, who(req));
    await audit(req, { action: 'DECLARATION_ITEM_MOVED', objectType: 'DECLARATION', objectId: id, detail: { item: itemId, from: it.line_no, to: target } }, c);
  });
  return card(id);
}

/** One value on every goods item at once (procedure, origin, preference, valuation method). */
const BULK = ['procedure', 'nat_procedure', 'origin', 'preference', 'valuation_method', 'package_kind'];
export async function bulkItems(req: Request, id: string, b: any) {
  const d = await requireDecl(id);
  editable(d, b.version);
  const field = String(b.field ?? '');
  if (!BULK.includes(field)) fail(400, 'Feltet kan ikke endres på alle vareposter samtidig.');
  const o = clean({ [field]: b.value }, ITEM);
  const n = await tx(async c => {
    const r = await c.query(`UPDATE declaration_item SET ${field} = $2 WHERE declaration_id = $1 AND ${field} IS DISTINCT FROM $2`, [id, o[field]]);
    if (r.rowCount) {
      await bump(c, id, who(req));
      await audit(req, { action: 'DECLARATION_ITEMS_BULK', objectType: 'DECLARATION', objectId: id, detail: { field, value: o[field], items: r.rowCount } }, c);
    }
    return r.rowCount ?? 0;
  });
  return { ...(await card(id)), changed: n };
}

/** A declaration is never deleted: a draft can be cancelled with a reason, and stays in the list. */
export async function cancel(req: Request, id: string, reason: unknown, version?: unknown) {
  const d = await requireDecl(id);
  editable(d, version);
  const why = str(reason);
  if (!why) fail(400, 'Oppgi en årsak.', 'REASON_REQUIRED');
  await tx(async c => {
    await c.query("UPDATE declaration SET status = 'CANCELLED', cancel_reason = $3, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1", [id, who(req), why]);
    await audit(req, { action: 'DECLARATION_CANCELLED', objectType: 'DECLARATION', objectId: id, before: { status: d.status }, after: { status: 'CANCELLED' }, detail: { reason: why } }, c);
  });
  return card(id);
}

/** A new draft with the same parties, transport and goods (date set to today, documents not copied). */
export async function copy(req: Request, id: string) {
  const d = await requireDecl(id);
  const its = await items(id);
  const header = Object.fromEntries(Object.keys(HEADER).filter(k => !['decl_date', 'docs', 'reexport_deadline'].includes(k)).map(k => [k, d[k]]));
  const lines = its.map(it => Object.fromEntries(Object.keys(ITEM).map(k => [k, it[k]])));
  const made = await create(req, { ...header, items: lines }, 'COPY');
  await audit(req, { action: 'DECLARATION_COPIED', objectType: 'DECLARATION', objectId: made.id, detail: { from: d.decl_no } });
  return made;
}

export async function storeDocument(req: Request, id: string, b: any) {
  const d = await requireDecl(id);
  if (d.status === 'CANCELLED') fail(409, 'Deklarasjonen er kansellert.');
  return docs.store(req, { type: 'DECLARATION', id }, b);
}

export const meta = async () => ({
  statuses: C.STATUSES, declTypes: C.DECL_TYPES, incoterms: C.INCOTERMS, transactionTypes: C.TRANSACTION_TYPES, transportModes: C.TRANSPORT_MODES,
  preferences: C.PREFERENCES, valuationMethods: C.VALUATION_METHODS, paymentMethods: C.PAYMENT_METHODS, declDocCodes: C.DECL_DOC_CODES,
  itemDocCodes: C.ITEM_DOC_CODES, bulkFields: BULK, euEftaEea: C.EU_EFTA_EEA, box12Types: B12_TYPES, box12Bases: B12_BASES
});

/** Box 48 choices: credit accounts of the parties (the customs debtor in box 8/2 first, then the representative in box 14). */
export async function paymentOptions(id: string) {
  const d = await requireDecl(id);
  const date = d.decl_date ?? today();
  const out: any[] = [];
  for (const [box, pid] of [['8', d.importer_id], ['2', d.exporter_id], ['14', d.declarant_id]] as const) {
    if (!pid) continue;
    const deb = !!(await one(`SELECT 1 FROM bp_role WHERE partner_id = $1 AND role_code = 'DEB' AND status = 'ACTIVE'
        AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)`, [pid, date]));
    if (box !== '14' && !deb) continue;
    for (const a of await query(`SELECT c.account, c.payment_type, b.legal_name FROM bp_credit_account c JOIN business_partner b ON b.id = c.partner_id
        WHERE c.partner_id = $1 AND c.status = 'ACTIVE' AND (c.valid_to IS NULL OR c.valid_to >= $2::date) ORDER BY c.payment_type DESC, c.account`, [pid, date]))
      if (!out.some(o => o.account === a.account)) out.push({ ...a, box, debtor: box !== '14' });
  }
  return { accounts: out, suggested: out.find(o => o.debtor) ?? out[0] ?? null };
}
