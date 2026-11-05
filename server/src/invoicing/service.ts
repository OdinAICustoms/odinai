import type { Request } from 'express';
import type pg from 'pg';
import { one, query, tx, pool, type Db } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as P from '../partners/repo.js';
import { inForce } from '../partners/rules.js';
import * as docs from '../documents.js';
import * as R from './pricing.js';
import { renderInvoice } from './pdf.js';

/**
 * Odin's own invoices (phase 4a): the basis (accepted declarations not yet invoiced), drafts, issuing
 * with an unbroken number series and KID, credit notes, and the PDF. See migration 011 for the model.
 */
/** Today in Norway: an invoice issued just after midnight is dated the new day, not yesterday in UTC. */
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const uuidOr404 = (id: string, what = 'fakturaen') => { if (!/^[0-9a-f-]{36}$/i.test(id)) fail(404, `Fant ikke ${what}.`); };

/* ------------------------------ settings ------------------------------ */
export interface Company { name: string; orgNo: string; vatRegistered: boolean; street: string; postalCode: string; city: string;
  email: string; phone: string; bankAccount: string; iban: string; bic: string; web: string }
export interface Settings { company: Company; dueDays: number; kid: boolean; footer: string; nextNo?: number }
const DEFAULTS: Settings = {
  company: { name: 'ODIN CUSTOMS AS', orgNo: '931481274', vatRegistered: true, street: '', postalCode: '', city: '', email: '', phone: '', bankAccount: '', iban: '', bic: '', web: '' },
  dueDays: 14, kid: true, footer: ''
};
export async function settings(db: Db = pool): Promise<Settings> {
  const v = (await one<{ value: any }>("SELECT value FROM app_settings WHERE key = 'invoicing'", [], db))?.value ?? {};
  const next = (await one<{ next_no: number }>("SELECT next_no FROM invoice_counter WHERE series = 'INVOICE'", [], db))?.next_no;
  return { ...DEFAULTS, ...v, company: { ...DEFAULTS.company, ...(v.company ?? {}) }, nextNo: next };
}
/** What must be in place before an invoice can be issued (bokføringsforskriften § 5-1-1: seller, buyer, account to pay to). */
export function settingsGaps(s: Settings) {
  const c = s.company, out: string[] = [];
  if (!str(c.name)) out.push('firmanavn');
  if (!/^\d{9}$/.test(String(c.orgNo ?? '').replace(/\s/g, ''))) out.push('organisasjonsnummer');
  if (!str(c.street) || !str(c.postalCode) || !str(c.city)) out.push('adresse');
  if (!R.validAccount(c.bankAccount)) out.push('kontonummer');
  return out;
}

export async function saveSettings(req: Request, b: any) {
  const cur = await settings();
  const c = { ...cur.company };
  for (const k of ['name', 'orgNo', 'street', 'postalCode', 'city', 'email', 'phone', 'bankAccount', 'iban', 'bic', 'web'] as const)
    if (b.company?.[k] !== undefined) c[k] = String(b.company[k] ?? '').trim();
  if (b.company?.vatRegistered !== undefined) c.vatRegistered = !!b.company.vatRegistered;
  c.orgNo = c.orgNo.replace(/\s/g, '');
  c.bankAccount = c.bankAccount.replace(/[\s.]/g, '');
  if (c.orgNo && !/^\d{9}$/.test(c.orgNo)) fail(400, 'Organisasjonsnummeret har 9 siffer.');
  if (c.bankAccount && !R.validAccount(c.bankAccount)) fail(400, 'Kontonummeret er ikke gyldig (11 siffer med kontrollsiffer).', 'ACCOUNT_INVALID');
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) fail(400, 'E-postadressen er ikke gyldig.');
  const dueDays = b.dueDays === undefined ? cur.dueDays : Math.round(num(b.dueDays));
  if (!(dueDays >= 0 && dueDays <= 120)) fail(400, 'Betalingsfristen må være mellom 0 og 120 dager.');
  const next: Settings = { company: c, dueDays, kid: b.kid === undefined ? cur.kid : !!b.kid, footer: b.footer === undefined ? cur.footer : String(b.footer ?? '').slice(0, 500) };
  await tx(async db => {
    await db.query(`INSERT INTO app_settings (key, value, updated_by) VALUES ('invoicing', $1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [JSON.stringify(next), req.user!.id]);
    if (b.nextNo !== undefined && b.nextNo !== null && b.nextNo !== '') {
      // The series only moves forward and never below a number already used.
      const want = Math.round(num(b.nextNo));
      const used = Number((await db.query('SELECT COALESCE(max(invoice_no), 0) n FROM invoice')).rows[0].n);
      const now = (await db.query("SELECT next_no FROM invoice_counter WHERE series = 'INVOICE' FOR UPDATE")).rows[0].next_no;
      if (!(want > 0)) fail(400, 'Neste fakturanummer må være et positivt heltall.');
      if (want < now || want <= used) fail(409, `Nummerserien kan bare flyttes fremover (neste nummer er ${now}).`, 'SERIES_BACKWARDS');
      await db.query("UPDATE invoice_counter SET next_no = $1 WHERE series = 'INVOICE'", [want]);
    }
    await audit(req, { action: 'INVOICE_SETTINGS', objectType: 'SETTINGS', objectId: 'invoicing', before: { ...cur.company, dueDays: cur.dueDays, kid: cur.kid, nextNo: cur.nextNo },
      after: { ...c, dueDays, kid: next.kid, nextNo: b.nextNo ?? cur.nextNo } }, db);
  });
  return settings();
}

/** The list price of a service (what applies when the partner card has no agreed price). */
export async function savePriceItem(req: Request, code: string, b: any) {
  const cur = await one('SELECT * FROM price_item WHERE code = $1', [code]);
  if (!cur) fail(404, 'Fant ikke tjenesten i prislisten.');
  const price = b.price !== undefined ? num(b.price) : Number(cur.price);
  if (!(price >= 0)) fail(400, 'Prisen må være et tall som er null eller større.');
  const free = b.free_lines !== undefined ? (str(b.free_lines) === null ? null : Math.round(num(b.free_lines))) : cur.free_lines;
  if (free !== null && !(free >= 0)) fail(400, 'Antall inkluderte vareposter må være null eller større.');
  const vat = b.mva_code !== undefined ? String(b.mva_code) : cur.mva_code;
  if (!(vat in R.VAT_RATE)) fail(400, 'Ukjent mva-kode.', 'VAT_CODE');
  const name = b.name_no !== undefined ? str(b.name_no) : cur.name_no;
  if (!name) fail(400, 'Tjenesten må ha et navn.');
  const after = { price: R.r2(price), free_lines: free, mva_code: vat, name_no: name, name_en: b.name_en !== undefined ? str(b.name_en) : cur.name_en,
    active: b.active !== undefined ? !!b.active : cur.active };
  await query('UPDATE price_item SET price = $2, free_lines = $3, mva_code = $4, name_no = $5, name_en = $6, active = $7 WHERE code = $1',
    [code, after.price, after.free_lines, after.mva_code, after.name_no, after.name_en, after.active]);
  await audit(req, { action: 'PRICE_LIST_CHANGED', objectType: 'SETTINGS', objectId: `price_item:${code}`,
    before: { price: Number(cur.price), free_lines: cur.free_lines, mva_code: cur.mva_code, name_no: cur.name_no, name_en: cur.name_en, active: cur.active }, after });
  return query('SELECT * FROM price_item ORDER BY sort');
}

export async function meta() {
  return { priceItems: await query('SELECT * FROM price_item ORDER BY sort'), vatCodes: Object.keys(R.VAT_RATE), vatRates: R.VAT_RATE, settings: await settings(), gaps: settingsGaps(await settings()) };
}

/* ------------------------------ the basis ------------------------------ */
/** Who paid duty and levies for a declaration (box 48), from the owner of the credit account. */
async function payerOf(d: any, companyOrgNo: string): Promise<{ payer: R.Payer; account: string | null }> {
  const account = str(d.payment_account)?.replace(/\s/g, '') ?? null;
  if (d.payment_method === 'KONTANT') return { payer: 'ODIN', account };
  if (!account) return { payer: d.payment_method === 'DAGSOPPGJOR' ? 'ODIN' : 'NONE', account };
  const owner = await one(`SELECT c.partner_id, (SELECT replace(i.identifier_value, ' ', '') FROM bp_identifier i WHERE i.partner_id = c.partner_id
      AND i.identifier_type = 'ORG_NO' AND i.status = 'ACTIVE' ORDER BY i.is_primary DESC LIMIT 1) org_no
    FROM bp_credit_account c WHERE c.account = $1 ORDER BY (c.status = 'ACTIVE') DESC LIMIT 1`, [account]);
  if (!owner) return { payer: 'UNKNOWN', account };
  if (owner.org_no && owner.org_no === companyOrgNo) return { payer: 'ODIN', account };
  if ([d.client_id, d.importer_id, d.exporter_id].includes(owner.partner_id)) return { payer: 'CLIENT', account };
  return { payer: 'UNKNOWN', account };
}

/** The declaration as accepted by TVINN: the calculation and goods items of the accepted version. */
async function declForInvoice(d: any, companyOrgNo: string): Promise<R.DeclForInvoice> {
  const v = await one(`SELECT snapshot->'calc' calc, jsonb_array_length(COALESCE(snapshot->'items', '[]'::jsonb)) n FROM declaration_version
      WHERE declaration_id = $1 AND result IN ('ACCEPTED', 'STAT_CHECK') ORDER BY version_no DESC LIMIT 1`, [d.id]);
  const n = v ? Number(v.n) : Number((await one('SELECT count(*) n FROM declaration_item WHERE declaration_id = $1', [d.id]))?.n ?? 0);
  const { payer, account } = await payerOf(d, companyOrgNo);
  return { id: d.id, decl_no: d.decl_no, direction: d.direction, mrn: d.mrn, decl_date: d.decl_date, itemCount: n, calc: v?.calc ?? {}, payer, account };
}

/** Proposed lines and warnings for one declaration, with the client's prices on the declaration date. */
async function proposal(d: any, clientId: string, s: Settings, items: R.PriceItem[], vatRegistered: boolean | null) {
  const di = await declForInvoice(d, s.company.orgNo);
  const date = d.decl_date ?? today();
  const prices = new Map<string, R.Price | null>();
  for (const it of items) {
    const p = await P.priceFor(clientId, it.code, date);
    prices.set(it.code, p ? { price: Number(p.price), freeLines: p.freeLines ?? null, source: p.source as R.Price['source'] } : null);
  }
  return { decl: di, ...R.propose(di, items, code => prices.get(code) ?? null, { vatRegistered }) };
}

const clientOf = (d: any) => d.client_id ?? (d.direction === 'EXPORT' ? d.exporter_id : d.importer_id) ?? null;
const vatRegisteredOf = async (clientId: string) => (await one('SELECT vat_registered FROM bp_registry WHERE partner_id = $1', [clientId]))?.vat_registered ?? null;
const invoicingOf = async (clientId: string) => (await one('SELECT consolidation, due_days, invoice_email, ehf FROM bp_invoicing WHERE partner_id = $1', [clientId]))
  ?? { consolidation: 'PER_DECLARATION', due_days: null, invoice_email: null, ehf: false };

const UNINVOICED = `d.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM invoice_declaration x WHERE x.declaration_id = d.id AND x.released_at IS NULL)`;

/**
 * The invoice basis: accepted declarations not on a live invoice, per client, with the proposed lines.
 * Monthly clients are due for the whole months up to upTo (default: the end of last month).
 */
export async function basis(f: { upTo?: string } = {}) {
  const upTo = isDate(f.upTo) ? f.upTo! : R.endOfPreviousMonth(today());
  const s = await settings();
  const items = (await P.priceItems()) as R.PriceItem[];
  const decls = await query(`SELECT d.* FROM declaration d WHERE ${UNINVOICED} ORDER BY d.decl_date NULLS LAST, d.decl_no`);
  const byClient = new Map<string, any>();
  const noClient: any[] = [];
  for (const d of decls) {
    const cid = clientOf(d);
    if (!cid) { noClient.push({ id: d.id, decl_no: d.decl_no, direction: d.direction, decl_date: d.decl_date }); continue; }
    let c = byClient.get(cid);
    if (!c) {
      const p = await one('SELECT id, partner_no, legal_name FROM business_partner WHERE id = $1', [cid]);
      const inv = await invoicingOf(cid);
      c = { client: p, consolidation: inv.consolidation, vatRegistered: await vatRegisteredOf(cid), declarations: [], total: 0, warnings: 0 };
      byClient.set(cid, c);
    }
    const pr = await proposal(d, cid, s, items, c.vatRegistered);
    const priced = pr.lines.map(l => ({ ...l, ...R.priceLine(l, s.company.vatRegistered) }));
    const t = R.totals(priced);
    c.declarations.push({ id: d.id, decl_no: d.decl_no, direction: d.direction, decl_date: d.decl_date, mrn: d.mrn, payer: pr.decl.payer,
      lines: priced, total: t.total, warnings: pr.warnings, due: c.consolidation !== 'MONTHLY' || (d.decl_date ?? today()) <= upTo });
    c.total = R.r2(c.total + t.total);
    c.warnings += pr.warnings.length;
  }
  return { upTo, clients: [...byClient.values()], noClient, gaps: settingsGaps(s) };
}

/* ------------------------------ drafts ------------------------------ */
async function insertLine(c: pg.PoolClient, invoiceId: string, l: R.LineDraft & { agreed_price?: number | null; credits_line_id?: string | null }, sort: number, vatRegistered: boolean) {
  const p = R.priceLine(l, vatRegistered);
  await c.query(`INSERT INTO invoice_line (invoice_id, sort, line_type, item_code, description, quantity, unit, unit_price, amount, vat_code, vat_rate, vat_amount,
      declaration_id, price_source, agreed_price, credits_line_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [invoiceId, sort, l.line_type, l.item_code, l.description.slice(0, 500), l.quantity, l.unit, l.unit_price, p.amount, p.vat_code, p.vat_rate, p.vat_amount,
      l.declaration_id, l.price_source, l.agreed_price ?? null, l.credits_line_id ?? null]);
}
async function recalc(c: Db, invoiceId: string, depositApplied = 0) {
  const lines = await query('SELECT amount, vat_amount, vat_code FROM invoice_line WHERE invoice_id = $1 AND removed_at IS NULL', [invoiceId], c);
  const t = R.totals(lines, depositApplied);
  await c.query(`UPDATE invoice SET net_total = $2, vat_total = $3, outlay_total = $4, deposit_applied = $5, total = $6, updated_at = now() WHERE id = $1`,
    [invoiceId, t.net_total, t.vat_total, t.outlay_total, t.deposit_applied, t.total]);
  return t;
}

/** A draft for one client covering the given accepted declarations (each on one live invoice at most). */
async function makeDraft(req: Request, clientId: string, declIds: string[], consolidation?: string) {
  const s = await settings();
  const items = (await P.priceItems()) as R.PriceItem[];
  const vatRegistered = await vatRegisteredOf(clientId);
  const decls = declIds.length ? await query(`SELECT * FROM declaration WHERE id = ANY($1::uuid[]) ORDER BY decl_date NULLS LAST, decl_no`, [declIds]) : [];
  if (decls.length !== declIds.length) fail(404, 'Fant ikke alle deklarasjonene.');
  for (const d of decls) {
    if (d.status !== 'ACCEPTED') fail(409, `${d.decl_no} er ikke godtatt av Tolletaten og kan ikke faktureres ennå.`, 'NOT_ACCEPTED');
    if (clientOf(d) !== clientId) fail(409, `${d.decl_no} tilhører en annen klient.`, 'OTHER_CLIENT');
  }
  const proposals: Awaited<ReturnType<typeof proposal>>[] = [];
  for (const d of decls) proposals.push(await proposal(d, clientId, s, items, vatRegistered));
  const dates = decls.map(d => d.decl_date).filter(Boolean).sort();
  const inv = await invoicingOf(clientId);
  const id = await tx(async c => {
    // Lock the declarations; the unique index on live links is the last guard against double invoicing.
    if (declIds.length) await c.query('SELECT id FROM declaration WHERE id = ANY($1::uuid[]) FOR UPDATE', [declIds]);
    const taken = declIds.length ? (await c.query(`SELECT d.decl_no FROM invoice_declaration x JOIN declaration d ON d.id = x.declaration_id
        WHERE x.declaration_id = ANY($1::uuid[]) AND x.released_at IS NULL`, [declIds])).rows : [];
    if (taken.length) fail(409, `${taken.map(t => t.decl_no).join(', ')} er allerede på en faktura.`, 'ALREADY_INVOICED');
    const row = (await c.query(`INSERT INTO invoice (client_id, delivery_from, delivery_to, consolidation, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [clientId, dates[0] ?? today(), dates[dates.length - 1] ?? today(), consolidation ?? inv.consolidation, req.user!.id])).rows[0];
    let sort = 0;
    for (const p of proposals) {
      await c.query('INSERT INTO invoice_declaration (invoice_id, declaration_id) VALUES ($1, $2)', [row.id, p.decl.id]);
      for (const l of p.lines) await insertLine(c, row.id, l, sort++, s.company.vatRegistered);
    }
    const t = await recalc(c, row.id);
    await audit(req, { action: 'INVOICE_DRAFTED', objectType: 'INVOICE', objectId: row.id,
      detail: { client: clientId, declarations: decls.map(d => d.decl_no), lines: sort, total: t.total, warnings: proposals.flatMap(p => p.warnings.map(w => w.rule)) } }, c);
    return row.id as string;
  });
  return id;
}

/** POST /invoices: a draft from chosen declarations, or an empty one for hours and other work. */
export async function createDraft(req: Request, b: any) {
  const clientId = str(b.clientId);
  if (!clientId) fail(400, 'Velg klienten fakturaen gjelder.', 'CLIENT_REQUIRED');
  uuidOr404(clientId!, 'klienten');
  const p = await one('SELECT id, merged_into FROM business_partner WHERE id = $1', [clientId]);
  if (!p) fail(404, 'Fant ikke klienten.');
  if (p.merged_into) fail(409, 'Partneren er slått sammen med en annen. Fakturer den partneren i stedet.', 'MERGED');
  const ids = Array.isArray(b.declarationIds) ? [...new Set(b.declarationIds.map(String))] as string[] : [];
  ids.forEach(i => uuidOr404(i, 'deklarasjonen'));
  return card(await makeDraft(req, clientId!, ids));
}

/**
 * Drafts for everything that is due: one per declaration for per-declaration clients, one per client for
 * the monthly ones (declarations dated up to upTo). Nothing is issued or sent automatically.
 */
export async function run(req: Request, b: any) {
  const bs = await basis({ upTo: b.upTo });
  const only = str(b.clientId);
  const created: { id: string; client: string; declarations: number }[] = [];
  for (const c of bs.clients) {
    if (only && c.client.id !== only) continue;
    const due = c.declarations.filter((d: any) => d.due);
    if (!due.length) continue;
    if (c.consolidation === 'MONTHLY') created.push({ id: await makeDraft(req, c.client.id, due.map((d: any) => d.id), 'MONTHLY'), client: c.client.legal_name, declarations: due.length });
    else for (const d of due) created.push({ id: await makeDraft(req, c.client.id, [d.id], 'PER_DECLARATION'), client: c.client.legal_name, declarations: 1 });
  }
  return { upTo: bs.upTo, created };
}

async function requireInvoice(id: string, db: Db = pool, lock = false) {
  uuidOr404(id);
  const i = await one(`SELECT * FROM invoice WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id], db);
  if (!i) fail(404, 'Fant ikke fakturaen.');
  return i!;
}
function requireDraft(i: any, version?: unknown) {
  if (i.status !== 'DRAFT') fail(409, 'Bare et utkast kan endres. En utstedt faktura krediteres.', 'NOT_DRAFT');
  if (version != null && Number(version) !== i.version) fail(409, 'Fakturaen er endret av en annen bruker. Last inn på nytt.', 'VERSION');
}
const bump = (c: Db, id: string, req: Request) => c.query('UPDATE invoice SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [id, req.user!.id]);

function lineInput(b: any, cur?: any) {
  const description = b.description !== undefined ? str(b.description) : cur?.description;
  if (!description) fail(400, 'Skriv en beskrivelse av linjen.', 'DESCRIPTION_REQUIRED');
  const quantity = b.quantity !== undefined ? num(b.quantity) : Number(cur?.quantity ?? 1);
  const unitPrice = b.unit_price !== undefined ? num(b.unit_price) : Number(cur?.unit_price ?? NaN);
  if (!(quantity > 0)) fail(400, 'Antallet må være større enn null.', 'QUANTITY');
  if (!Number.isFinite(unitPrice)) fail(400, 'Enhetsprisen må være et tall.', 'PRICE');
  const vat = b.vat_code !== undefined ? String(b.vat_code) : cur?.vat_code ?? 'HIGH';
  if (!(vat in R.VAT_RATE)) fail(400, 'Ukjent mva-kode.', 'VAT_CODE');
  return { description: description!, quantity: Math.round(quantity * 1000) / 1000, unit_price: R.r2(unitPrice), vat_code: vat as R.VatCode,
    unit: str(b.unit) ?? cur?.unit ?? 'stk' };
}

export async function addLine(req: Request, id: string, b: any) {
  const s = await settings();
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    const l = lineInput(b);
    const item = str(b.item_code) ? await one('SELECT * FROM price_item WHERE code = $1', [b.item_code], c) : null;
    const sort = Number((await c.query('SELECT COALESCE(max(sort), 0) + 1 n FROM invoice_line WHERE invoice_id = $1', [id])).rows[0].n);
    const type = l.vat_code === 'OUTLAY' ? 'OUTLAY' : item?.unit === 'PER_HOUR' ? 'SERVICE' : 'OTHER';
    await insertLine(c, id, { line_type: type, item_code: item?.code ?? null, ...l, declaration_id: null, price_source: 'MANUAL' }, sort, s.company.vatRegistered);
    await recalc(c, id);
    await bump(c, id, req);
    await audit(req, { action: 'INVOICE_LINE_ADDED', objectType: 'INVOICE', objectId: id, detail: l }, c);
  });
  return card(id);
}

/** Change a draft line. When a person changes a price from the agreement or list, the original price is kept beside it. */
export async function updateLine(req: Request, id: string, lineId: string, b: any) {
  const s = await settings();
  uuidOr404(lineId, 'linjen');
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    const cur = await one('SELECT * FROM invoice_line WHERE id = $1 AND invoice_id = $2 AND removed_at IS NULL', [lineId, id], c);
    if (!cur) fail(404, 'Fant ikke linjen.');
    const l = lineInput(b, cur);
    const priceChanged = Number(cur.unit_price) !== l.unit_price;
    const agreed = cur.agreed_price ?? (priceChanged && cur.price_source !== 'MANUAL' ? cur.unit_price : null);
    const p = R.priceLine(l, s.company.vatRegistered);
    await c.query(`UPDATE invoice_line SET description = $2, quantity = $3, unit = $4, unit_price = $5, amount = $6, vat_code = $7, vat_rate = $8, vat_amount = $9, agreed_price = $10
        WHERE id = $1`, [lineId, l.description, l.quantity, l.unit, l.unit_price, p.amount, p.vat_code, p.vat_rate, p.vat_amount,
      agreed != null && Number(agreed) === l.unit_price ? null : agreed]);
    await recalc(c, id);
    await bump(c, id, req);
    await audit(req, { action: 'INVOICE_LINE_CHANGED', objectType: 'INVOICE', objectId: id,
      before: { description: cur.description, quantity: Number(cur.quantity), unit_price: Number(cur.unit_price), vat_code: cur.vat_code },
      after: { description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat_code: l.vat_code }, detail: { line: lineId, agreedPrice: agreed } }, c);
  });
  return card(id);
}

export async function removeLine(req: Request, id: string, lineId: string, b: any = {}) {
  uuidOr404(lineId, 'linjen');
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    const cur = await one('SELECT * FROM invoice_line WHERE id = $1 AND invoice_id = $2 AND removed_at IS NULL', [lineId, id], c);
    if (!cur) fail(404, 'Fant ikke linjen.');
    await c.query('UPDATE invoice_line SET removed_at = now(), removed_by = $2 WHERE id = $1', [lineId, req.user!.id]);
    await recalc(c, id);
    await bump(c, id, req);
    await audit(req, { action: 'INVOICE_LINE_REMOVED', objectType: 'INVOICE', objectId: id, detail: { line: lineId, description: cur.description, amount: Number(cur.amount) } }, c);
  });
  return card(id);
}

/** Take a declaration off a draft (its lines go with it); it returns to the basis. */
export async function removeDeclaration(req: Request, id: string, declId: string, b: any = {}) {
  uuidOr404(declId, 'deklarasjonen');
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    const link = await one('SELECT * FROM invoice_declaration WHERE invoice_id = $1 AND declaration_id = $2 AND released_at IS NULL', [id, declId], c);
    if (!link) fail(404, 'Deklarasjonen er ikke på dette utkastet.');
    await c.query('UPDATE invoice_declaration SET released_at = now() WHERE invoice_id = $1 AND declaration_id = $2', [id, declId]);
    await c.query('UPDATE invoice_line SET removed_at = now(), removed_by = $3 WHERE invoice_id = $1 AND declaration_id = $2 AND removed_at IS NULL', [id, declId, req.user!.id]);
    await recalc(c, id);
    await bump(c, id, req);
    await audit(req, { action: 'INVOICE_DECLARATION_REMOVED', objectType: 'INVOICE', objectId: id, detail: { declaration: declId } }, c);
  });
  return card(id);
}

export async function updateHeader(req: Request, id: string, b: any) {
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    const next = {
      your_ref: b.your_ref !== undefined ? str(b.your_ref)?.slice(0, 200) ?? null : i.your_ref,
      note: b.note !== undefined ? str(b.note)?.slice(0, 2000) ?? null : i.note,
      delivery_from: b.delivery_from !== undefined ? (isDate(b.delivery_from) ? b.delivery_from : fail(400, 'Ugyldig dato.')) : i.delivery_from,
      delivery_to: b.delivery_to !== undefined ? (isDate(b.delivery_to) ? b.delivery_to : fail(400, 'Ugyldig dato.')) : i.delivery_to
    };
    if (next.delivery_from && next.delivery_to && next.delivery_from > next.delivery_to) fail(400, 'Leveringsperioden slutter før den begynner.');
    await c.query('UPDATE invoice SET your_ref = $2, note = $3, delivery_from = $4, delivery_to = $5 WHERE id = $1', [id, next.your_ref, next.note, next.delivery_from, next.delivery_to]);
    await bump(c, id, req);
    await audit(req, { action: 'INVOICE_CHANGED', objectType: 'INVOICE', objectId: id,
      before: { your_ref: i.your_ref, note: i.note, delivery_from: i.delivery_from, delivery_to: i.delivery_to }, after: next }, c);
  });
  return card(id);
}

/** Discard a draft (kept, never deleted); its declarations return to the basis. */
export async function discard(req: Request, id: string, b: any = {}) {
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    await c.query("UPDATE invoice SET status = 'DISCARDED', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1", [id, req.user!.id]);
    await c.query('UPDATE invoice_declaration SET released_at = now() WHERE invoice_id = $1 AND released_at IS NULL', [id]);
    await audit(req, { action: 'INVOICE_DISCARDED', objectType: 'INVOICE', objectId: id, before: { status: 'DRAFT' }, after: { status: 'DISCARDED' }, detail: { reason: str(b.reason) } }, c);
  });
  return card(id);
}

/* ------------------------------ issuing ------------------------------ */
/** The client as printed on the invoice: name, invoice address (else the standard address), org. no. */
async function buyerOf(clientId: string) {
  const p = await P.get(clientId);
  const d = today();
  const addr = p.addresses.find((a: any) => a.address_type === 'INVOICE' && inForce(a, d)) ?? p.standardAddress;
  const inv = p.invoicing ?? {};
  return { id: p.id, partnerNo: p.partner_no, name: p.legal_name, orgNo: p.orgNo, vatNo: p.vatNo, country: p.registration_country,
    street: addr?.street ?? null, postalCode: addr?.postal_code ?? null, city: addr?.city ?? null, addressCountry: addr?.country_code ?? null,
    email: inv.invoice_email ?? null, ehf: !!inv.ehf, language: p.language, dueDays: inv.due_days ?? null,
    deposit: p.deposit_paid ? Number(p.deposit_amount ?? 0) : 0 };
}
const sellerOf = (s: Settings) => ({ ...s.company, footer: s.footer });

/** The next number in the unbroken series; the row lock holds until the issuing transaction ends. */
async function takeNumber(c: pg.PoolClient) {
  return Number((await c.query("UPDATE invoice_counter SET next_no = next_no + 1 WHERE series = 'INVOICE' RETURNING next_no - 1 AS no")).rows[0].no);
}

/**
 * Issue a draft: the next number, issue and due date, KID, the deposit set off, seller and buyer frozen.
 * The PDF is made right after; if that fails the invoice stays issued and the PDF is made when asked for.
 */
export async function issue(req: Request, id: string, b: any = {}) {
  const s = await settings();
  const gaps = settingsGaps(s);
  if (gaps.length) fail(409, `Fyll ut firmaopplysningene under Fakturering › Innstillinger før du utsteder: ${gaps.join(', ')}.`, 'SETTINGS_INCOMPLETE');
  const issueDate = b.issueDate !== undefined && b.issueDate !== null && b.issueDate !== '' ? (isDate(b.issueDate) ? b.issueDate : fail(400, 'Ugyldig fakturadato.')) : today();
  if (issueDate > today()) fail(400, 'Fakturadatoen kan ikke være frem i tid.', 'FUTURE_DATE');
  const pre = await requireInvoice(id);
  requireDraft(pre, b.version);
  if (pre.kind !== 'INVOICE') fail(409, 'En kreditnota utstedes når den lages.');
  const buyer = await buyerOf(pre.client_id);
  if (!buyer.street || !buyer.city) fail(409, 'Klienten mangler adresse. Legg inn en fakturaadresse eller standardadresse på partnerkortet.', 'BUYER_ADDRESS');
  await tx(async c => {
    const i = await requireInvoice(id, c, true);
    requireDraft(i, b.version);
    const lines = await query('SELECT * FROM invoice_line WHERE invoice_id = $1 AND removed_at IS NULL', [id], c);
    if (!lines.length) fail(409, 'Fakturaen har ingen linjer.', 'NO_LINES');
    const gross = R.totals(lines);
    if (gross.total < 0) fail(409, 'Fakturaen har et negativt beløp. Bruk en kreditnota for å gi tilbake penger.', 'NEGATIVE');
    // The client's deposit (partner card) is set off against what is left of it.
    let deposit = 0;
    if (buyer.deposit > 0) {
      const used = Number((await c.query(`SELECT COALESCE(sum(deposit_applied), 0) u FROM invoice WHERE client_id = $1 AND status IN ('ISSUED', 'CREDITED')`, [i.client_id])).rows[0].u);
      deposit = Math.min(Math.max(0, buyer.deposit - used), gross.total);
    }
    const no = await takeNumber(c);
    const due = R.addDays(issueDate, buyer.dueDays ?? s.dueDays);
    const k = s.kid ? R.kid(buyer.partnerNo, no) : null;
    const t = await recalc(c, id, deposit);
    await c.query(`UPDATE invoice SET status = 'ISSUED', invoice_no = $2, issue_date = $3, due_date = $4, kid = $5, seller = $6, buyer = $7,
        issued_at = now(), issued_by = $8, version = version + 1, updated_by = $8 WHERE id = $1`,
      [id, no, issueDate, due, k, JSON.stringify(sellerOf(s)), JSON.stringify(buyer), req.user!.id]);
    await audit(req, { action: 'INVOICE_ISSUED', objectType: 'INVOICE', objectId: id, before: { status: 'DRAFT' }, after: { status: 'ISSUED', invoice_no: no },
      detail: { invoiceNo: no, issueDate, dueDate: due, kid: k, total: t.total, deposit: t.deposit_applied } }, c);
  });
  await makePdf(req, id).catch(e => console.error('Faktura-PDF', id, e));
  return card(id);
}

/**
 * A credit note for an issued invoice: the next number, whole lines with the opposite sign. Without a
 * choice of lines every line not yet credited is credited; when no line is left the invoice is CREDITED
 * and its declarations go back to the basis (to be invoiced again, correctly).
 */
export async function credit(req: Request, id: string, b: any = {}) {
  const reason = str(b.reason);
  if (!reason) fail(400, 'Oppgi hvorfor fakturaen krediteres.', 'REASON_REQUIRED');
  const s = await settings();
  const creditId = await tx(async c => {
    const i = await requireInvoice(id, c, true);
    if (i.kind !== 'INVOICE' || i.status !== 'ISSUED') fail(409, 'Bare en utstedt faktura som ikke er kreditert, kan krediteres.', 'NOT_CREDITABLE');
    const open = await query(`SELECT l.* FROM invoice_line l WHERE l.invoice_id = $1 AND l.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoice_line x WHERE x.credits_line_id = l.id) ORDER BY l.sort`, [id], c);
    const want = Array.isArray(b.lineIds) && b.lineIds.length ? new Set(b.lineIds.map(String)) : null;
    const chosen = want ? open.filter(l => want.has(l.id)) : open;
    if (want && chosen.length !== want.size) fail(409, 'En eller flere av linjene er allerede kreditert eller hører ikke til fakturaen.', 'LINE_NOT_OPEN');
    if (!chosen.length) fail(409, 'Alle linjene er allerede kreditert.', 'NOTHING_TO_CREDIT');
    const full = chosen.length === open.length;
    const row = (await c.query(`INSERT INTO invoice (kind, client_id, delivery_from, delivery_to, consolidation, credited_invoice_id, credit_reason, your_ref, created_by, updated_by)
        VALUES ('CREDIT', $1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [i.client_id, i.delivery_from, i.delivery_to, i.consolidation, id, reason, i.your_ref, req.user!.id])).rows[0];
    let sort = 0;
    for (const l of chosen)
      await insertLine(c, row.id, { line_type: l.line_type, item_code: l.item_code, description: l.description, quantity: -Number(l.quantity), unit: l.unit,
        unit_price: Number(l.unit_price), vat_code: l.vat_code, declaration_id: l.declaration_id, price_source: l.price_source, credits_line_id: l.id }, sort++, Number(l.vat_rate) > 0);
    // The deposit set off on the invoice is given back with the last credit note.
    const t = await recalc(c, row.id, full ? -Number(i.deposit_applied) : 0);
    const no = await takeNumber(c);
    const date = today();
    await c.query(`UPDATE invoice SET status = 'ISSUED', invoice_no = $2, issue_date = $3, due_date = $3, seller = $4, buyer = $5, issued_at = now(), issued_by = $6 WHERE id = $1`,
      [row.id, no, date, JSON.stringify(sellerOf(s)), JSON.stringify(i.buyer), req.user!.id]);
    if (full) {
      await c.query("UPDATE invoice SET status = 'CREDITED', updated_at = now(), updated_by = $2 WHERE id = $1", [id, req.user!.id]);
      await c.query('UPDATE invoice_declaration SET released_at = now() WHERE invoice_id = $1 AND released_at IS NULL', [id]);
    }
    await audit(req, { action: 'INVOICE_CREDITED', objectType: 'INVOICE', objectId: id, before: { status: 'ISSUED' }, after: { status: full ? 'CREDITED' : 'ISSUED' },
      detail: { creditNote: row.id, creditNo: no, reason, lines: chosen.length, full, total: t.total } }, c);
    await audit(req, { action: 'CREDIT_NOTE_ISSUED', objectType: 'INVOICE', objectId: row.id, detail: { invoiceNo: no, credits: i.invoice_no, reason, total: t.total } }, c);
    return row.id as string;
  });
  await makePdf(req, creditId).catch(e => console.error('Kreditnota-PDF', creditId, e));
  return card(creditId);
}

/* ------------------------------ PDF ------------------------------ */
async function pdfData(id: string) {
  const i = await requireInvoice(id);
  const lines = await query('SELECT * FROM invoice_line WHERE invoice_id = $1 AND removed_at IS NULL ORDER BY sort', [id]);
  const s = await settings();
  const credits = i.credited_invoice_id ? await one('SELECT invoice_no, issue_date FROM invoice WHERE id = $1', [i.credited_invoice_id]) : null;
  return { invoice: { ...i, seller: i.seller ?? sellerOf(s), buyer: i.buyer ?? await buyerOf(i.client_id) }, lines, vat: R.vatSummary(lines), credits };
}
async function makePdf(req: Request, id: string) {
  const data = await pdfData(id);
  const buffer = await renderInvoice(data);
  const name = `${data.invoice.kind === 'CREDIT' ? 'Kreditnota' : 'Faktura'}-${data.invoice.invoice_no}.pdf`;
  const doc = await docs.store(req, { type: 'INVOICE', id }, { filename: name, mime: 'application/pdf', contentBase64: buffer.toString('base64'), docCode: data.invoice.kind });
  await query('UPDATE invoice SET document_id = $2 WHERE id = $1 AND document_id IS NULL', [id, doc.id]);
  return { buffer, filename: name };
}
/** The PDF: the stored one for an issued invoice (made now if missing), a marked preview for a draft. */
export async function pdf(req: Request, id: string) {
  const i = await requireInvoice(id);
  if (i.status === 'DRAFT' || i.status === 'DISCARDED') {
    const data = await pdfData(id);
    return { buffer: await renderInvoice(data, { preview: true }), filename: `Utkast-faktura.pdf` };
  }
  if (i.document_id) {
    const d = await docs.read(i.document_id);
    if (d && d.intact) return { buffer: d.buffer, filename: d.filename };
    if (d && !d.intact) fail(500, 'Den lagrede PDF-en besto ikke integritetskontrollen.', 'PDF_DAMAGED');
  }
  return makePdf(req, id);
}

/* ------------------------------ reading ------------------------------ */
/** What the screens show as the state: open, overdue and paid are worked out from the amounts and the due date. */
function displayStatus(i: any, credited: number) {
  if (i.status !== 'ISSUED' || i.kind !== 'INVOICE') return i.status;
  const open = R.r2(Number(i.total) - Number(i.paid_amount) - credited);
  if (open <= 0.005) return 'PAID';
  return i.due_date && i.due_date < today() ? 'OVERDUE' : 'OPEN';
}

export async function card(id: string) {
  const i = await requireInvoice(id);
  const client = await one('SELECT id, partner_no, legal_name FROM business_partner WHERE id = $1', [i.client_id]);
  const lines = await query(`SELECT l.*, d.decl_no, (SELECT ci.invoice_no FROM invoice_line x JOIN invoice ci ON ci.id = x.invoice_id WHERE x.credits_line_id = l.id) credited_by_no
      FROM invoice_line l LEFT JOIN declaration d ON d.id = l.declaration_id WHERE l.invoice_id = $1 ORDER BY l.removed_at NULLS FIRST, l.sort`, [id]);
  const declarations = await query(`SELECT d.id, d.decl_no, d.direction, d.decl_date, d.mrn, x.released_at FROM invoice_declaration x JOIN declaration d ON d.id = x.declaration_id
      WHERE x.invoice_id = $1 ORDER BY d.decl_date NULLS LAST, d.decl_no`, [id]);
  const creditNotes = await query(`SELECT id, invoice_no, issue_date, total, credit_reason FROM invoice WHERE credited_invoice_id = $1 AND status <> 'DISCARDED' ORDER BY invoice_no`, [id]);
  const credited = R.r2(-creditNotes.reduce((s, c) => s + Number(c.total), 0));
  const credits = i.credited_invoice_id ? await one('SELECT id, invoice_no, issue_date FROM invoice WHERE id = $1', [i.credited_invoice_id]) : null;
  const users = await query('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [[i.created_by, i.issued_by].filter(Boolean)]);
  const nameOf = (u: string | null) => users.find(x => x.id === u)?.name ?? null;
  const live = lines.filter(l => !l.removed_at);

  // A draft is checked again when it is shown: missing prices, payer unknown, prices changed by hand.
  const warnings: R.Warning[] = [];
  if (i.status === 'DRAFT') {
    const s = await settings();
    const items = (await P.priceItems()) as R.PriceItem[];
    const vatReg = await vatRegisteredOf(i.client_id);
    for (const d of declarations.filter(d => !d.released_at)) {
      const row = await one('SELECT * FROM declaration WHERE id = $1', [d.id]);
      warnings.push(...(await proposal(row, i.client_id, s, items, vatReg)).warnings);
    }
    for (const l of live.filter(l => l.agreed_price != null))
      warnings.push({ rule: 'PRICE_CHANGED', msg: `«${l.description}»: prisen er endret fra ${Number(l.agreed_price).toFixed(2).replace('.', ',')} til ${Number(l.unit_price).toFixed(2).replace('.', ',')} kr.` });
    const gaps = settingsGaps(s);
    if (gaps.length) warnings.push({ rule: 'SETTINGS_INCOMPLETE', msg: `Firmaopplysninger mangler før fakturaen kan utstedes: ${gaps.join(', ')}.` });
    if (!live.length) warnings.push({ rule: 'NO_LINES', msg: 'Utkastet har ingen linjer.' });
  }
  return {
    ...i, client, lines, declarations, creditNotes, credits, credited, warnings,
    open: i.kind === 'INVOICE' && i.status === 'ISSUED' ? R.r2(Number(i.total) - Number(i.paid_amount) - credited) : 0,
    display: displayStatus(i, credited), vatSummary: R.vatSummary(live),
    created_by_name: nameOf(i.created_by), issued_by_name: nameOf(i.issued_by), editable: i.status === 'DRAFT'
  };
}

export async function list(f: Record<string, string> = {}) {
  const where: string[] = [], args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace(/\?/g, `$${args.length}`)); };
  const st = String(f.status ?? '').toUpperCase();
  if (['DRAFT', 'ISSUED', 'CREDITED', 'DISCARDED'].includes(st)) add('i.status = ?', st);
  else if (st === 'OPEN' || st === 'OVERDUE' || st === 'PAID') add("i.status = 'ISSUED' AND i.kind = ?", 'INVOICE');
  else if (st !== 'ALL') where.push("i.status <> 'DISCARDED'");
  if (f.kind === 'CREDIT' || f.kind === 'INVOICE') add('i.kind = ?', f.kind);
  if (f.client && /^[0-9a-f-]{36}$/i.test(f.client)) add('i.client_id = ?', f.client);
  if (isDate(f.from)) add('COALESCE(i.issue_date, i.created_at::date) >= ?', f.from);
  if (isDate(f.to)) add('COALESCE(i.issue_date, i.created_at::date) <= ?', f.to);
  if (f.q) add(`(i.invoice_no::text = ? OR c.legal_name ILIKE '%' || ? || '%' OR i.kid = ? OR EXISTS (SELECT 1 FROM invoice_declaration x JOIN declaration d ON d.id = x.declaration_id
      WHERE x.invoice_id = i.id AND d.decl_no ILIKE '%' || ? || '%'))`, String(f.q).trim());
  const rows = await query(`SELECT i.id, i.invoice_no, i.kind, i.status, i.issue_date, i.due_date, i.total, i.paid_amount, i.kid, i.created_at, i.consolidation,
      c.id client_id, c.partner_no, c.legal_name client_name, ci.invoice_no credits_no,
      (SELECT count(*) FROM invoice_declaration x WHERE x.invoice_id = i.id AND x.released_at IS NULL) declarations,
      (SELECT COALESCE(-sum(n.total), 0) FROM invoice n WHERE n.credited_invoice_id = i.id AND n.status <> 'DISCARDED') credited
    FROM invoice i JOIN business_partner c ON c.id = i.client_id LEFT JOIN invoice ci ON ci.id = i.credited_invoice_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (i.status = 'DRAFT') DESC, i.invoice_no DESC NULLS FIRST, i.created_at DESC LIMIT 500`, args);
  const out = rows.map(r => ({ ...r, display: displayStatus(r, Number(r.credited)), open: r.kind === 'INVOICE' && r.status === 'ISSUED' ? R.r2(Number(r.total) - Number(r.paid_amount) - Number(r.credited)) : 0 }));
  return ['OPEN', 'OVERDUE', 'PAID'].includes(st) ? out.filter(r => r.display === st) : out;
}

/** Counts for the module's sub-menu and overview. */
export async function summary() {
  const all = await list({});
  const b = await basis();
  return {
    drafts: all.filter(r => r.status === 'DRAFT').length,
    open: all.filter(r => r.display === 'OPEN').length,
    overdue: all.filter(r => r.display === 'OVERDUE').length,
    openAmount: R.r2(all.filter(r => r.display === 'OPEN' || r.display === 'OVERDUE').reduce((s, r) => s + r.open, 0)),
    basis: b.clients.reduce((s, c) => s + c.declarations.length, 0), noClient: b.noClient.length
  };
}
