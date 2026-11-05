import type pg from 'pg';
import { one, pool, query, tx } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as R from './pricing.js';

/**
 * Bookkeeping in Fiken (phase 4c). Fiken API v2 (https://api.fiken.no/api/v2, OpenAPI spec at /docs):
 *  * An issued invoice or credit note is "Annet salg": POST /companies/{slug}/sales, kind external_invoice,
 *    saleNumber = our invoice number, amounts in øre per line (netPrice, vat), account and vatType per line.
 *    A credit note is a sale with negative lines.
 *  * A payment: POST /sales/{saleId}/payments {date, account, amount}; a reversal: DELETE that payment.
 *  * A fully credited, unpaid invoice and its credit note are marked settled: PATCH /sales/{id}/settled.
 *  * The customer is found by our link, else organizationNumber, else memberNumberString (our partner
 *    number), else created; Fiken returns new ids in the Location header.
 * Adapters: FIKEN_ADAPTER=simulator (default; checks the requests, sends nothing) or live (FIKEN_TOKEN in
 * .env and the company slug in the settings). Before live use, try a credit note against Fiken's test
 * company: negative lines on "Annet salg" are what this code relies on.
 */
const RETRY = (process.env.FIKEN_RETRY_SECONDS || '10,60,300').split(',').map(Number).filter(n => n > 0);
export const adapterName = () => (process.env.FIKEN_ADAPTER === 'live' ? 'live' : 'simulator');
export const SALE_VAT_TYPES = ['NONE', 'HIGH', 'MEDIUM', 'RAW_FISH', 'LOW', 'EXEMPT_IMPORT_EXPORT', 'EXEMPT', 'OUTSIDE', 'EXEMPT_REVERSE'];
export const ACCOUNT_RE = /^\d{4}(:\d{5})?$/;

export interface FikenSettings { companySlug: string; auto: boolean; paymentAccount: string; accounts: Record<string, string>; vatTypes: Record<string, string> }
export const FIKEN_DEFAULTS: FikenSettings = { companySlug: '', auto: true, paymentAccount: '',
  accounts: { HIGH: '3000', ZERO: '3100', EXEMPT: '3200', OUTLAY: '2910' }, vatTypes: { HIGH: 'HIGH', ZERO: 'EXEMPT', EXEMPT: 'OUTSIDE', OUTLAY: 'NONE' } };
export async function fikenSettings(db: pg.Pool | pg.PoolClient = pool): Promise<FikenSettings> {
  const v = (await one<{ value: any }>("SELECT value FROM app_settings WHERE key = 'invoicing'", [], db))?.value?.fiken ?? {};
  return { ...FIKEN_DEFAULTS, ...v, accounts: { ...FIKEN_DEFAULTS.accounts, ...(v.accounts ?? {}) }, vatTypes: { ...FIKEN_DEFAULTS.vatTypes, ...(v.vatTypes ?? {}) } };
}
/** Settings check; problems are listed, never fixed silently. */
export function fikenGaps(f: FikenSettings, adapter = adapterName()) {
  const out: string[] = [];
  for (const [k, a] of Object.entries(f.accounts)) if (!ACCOUNT_RE.test(String(a ?? ''))) out.push(`konto for ${k}`);
  for (const [k, t] of Object.entries(f.vatTypes)) if (!SALE_VAT_TYPES.includes(String(t))) out.push(`mva-type for ${k}`);
  if (!ACCOUNT_RE.test(f.paymentAccount ?? '')) out.push('bankkonto for innbetalinger');
  if (adapter === 'live' && !f.companySlug) out.push('selskapets navn i Fiken (slug)');
  if (adapter === 'live' && !process.env.FIKEN_TOKEN) out.push('FIKEN_TOKEN i .env');
  return out;
}

/* ------------------------------ what is sent ------------------------------ */
/**
 * The sale for an issued invoice or credit note. Line VAT in øre is adjusted on the largest line of each
 * rate so the lines add up to the invoice's VAT per rate (rounded once per rate).
 */
export function saleRequest(inv: any, lines: any[], f: FikenSettings, customerId: number) {
  const out = lines.map(l => ({
    description: String(l.description).slice(0, 200), netPrice: R.ore(l.amount), vat: R.ore(l.vat_amount),
    account: f.accounts[l.vat_code] ?? f.accounts.HIGH, vatType: Number(l.vat_rate) > 0 ? f.vatTypes[l.vat_code] ?? 'HIGH' : (l.vat_code === 'HIGH' ? 'NONE' : f.vatTypes[l.vat_code] ?? 'NONE'),
    _key: `${l.vat_code}:${Number(l.vat_rate)}`
  }));
  for (const v of R.vatSummary(lines)) {
    const mine = out.filter(o => o._key === `${v.code}:${v.rate}`);
    if (!mine.length) continue;
    const diff = R.ore(v.vat) - mine.reduce((s, o) => s + o.vat, 0);
    if (diff) mine.reduce((a, b) => (Math.abs(b.netPrice) > Math.abs(a.netPrice) ? b : a)).vat += diff;
  }
  return {
    saleNumber: String(inv.invoice_no), date: inv.issue_date, kind: 'external_invoice', currency: inv.currency ?? 'NOK', customerId,
    ...(inv.kind === 'INVOICE' && inv.due_date ? { dueDate: inv.due_date } : {}), ...(inv.kid ? { kid: inv.kid } : {}),
    lines: out.map(({ _key, ...l }) => l)
  };
}
export const contactRequest = (b: any) => ({
  name: String(b.name ?? '').slice(0, 200), customer: true, ...(b.orgNo ? { organizationNumber: String(b.orgNo) } : {}), ...(b.email ? { email: b.email } : {}),
  memberNumberString: b.partnerNo, language: b.language === 'EN' ? 'ENGLISH' : 'NORWEGIAN',
  address: { streetAddress: b.street ?? '', postCode: b.postalCode ?? '', city: b.city ?? '', country: (b.addressCountry ?? b.country ?? 'NO') === 'NO' ? 'Norway' : (b.addressCountry ?? b.country) }
});
export const paymentRequest = (p: any, f: FikenSettings) => ({ date: p.paid_date, account: f.paymentAccount, amount: R.ore(p.amount) });

/* ------------------------------ adapters ------------------------------ */
interface Adapter {
  findContact(orgNo: string | null, memberNo: string): Promise<number | null>;
  createContact(body: any): Promise<number>;
  findSale(saleNumber: string): Promise<number | null>;
  createSale(body: any): Promise<number>;
  createPayment(saleId: number, body: any): Promise<number>;
  deletePayment(saleId: number, paymentId: number, description: string): Promise<void>;
  settle(saleId: number, date: string): Promise<void>;
}
const permanent = (msg: string) => Object.assign(new Error(msg), { permanent: true });

/** Checks each request against Fiken's schema (as far as it is written down) and hands out ids. */
export function simulatorCheckSale(b: any) {
  const errs: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? ''))) errs.push('date');
  if (b.kind !== 'external_invoice') errs.push('kind');
  if (!/^[A-Z]{3}$/.test(String(b.currency ?? ''))) errs.push('currency');
  if (!Number.isInteger(b.customerId)) errs.push('customerId');
  if (b.kid && !/^\d{2,25}$/.test(b.kid)) errs.push('kid');
  if (!Array.isArray(b.lines) || !b.lines.length) errs.push('lines');
  for (const [i, l] of (b.lines ?? []).entries()) {
    if (!l.description || l.description.length > 200) errs.push(`lines[${i}].description`);
    if (!Number.isInteger(l.netPrice) || !Number.isInteger(l.vat)) errs.push(`lines[${i}] beløp i øre`);
    if (!SALE_VAT_TYPES.includes(l.vatType)) errs.push(`lines[${i}].vatType`);
    if (!ACCOUNT_RE.test(String(l.account ?? ''))) errs.push(`lines[${i}].account`);
  }
  return errs;
}
let simId = Date.now() % 1e9;
const simulator: Adapter = {
  async findContact() { return null; },
  async createContact(b) { if (!b.name) throw permanent('Fiken (simulator): kontakten mangler navn.'); return ++simId; },
  async findSale() { return null; },
  async createSale(b) { const e = simulatorCheckSale(b); if (e.length) throw permanent(`Fiken (simulator) avviste salget: ${e.join(', ')}.`); return ++simId; },
  async createPayment(_s, b) { if (!ACCOUNT_RE.test(String(b.account ?? '')) || !Number.isInteger(b.amount) || b.amount <= 0) throw permanent('Fiken (simulator) avviste innbetalingen: konto eller beløp.'); return ++simId; },
  async deletePayment() { /* nothing to undo */ },
  async settle() { /* nothing to settle */ }
};

function live(slug: string): Adapter {
  const base = `https://api.fiken.no/api/v2/companies/${encodeURIComponent(slug)}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${process.env.FIKEN_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 300);
      const e = new Error(`Fiken svarte ${r.status}${text ? `: ${text}` : ''}`);
      // A refused request (4xx except 429) will be refused again: no blind retries.
      if (r.status >= 400 && r.status < 500 && r.status !== 429) (e as any).permanent = true;
      throw e;
    }
    return r;
  };
  const idFrom = (r: Response) => { const id = Number((r.headers.get('Location') ?? '').split('/').pop()); if (!id) throw new Error('Fiken ga ingen id (Location-header mangler).'); return id; };
  const first = async (path: string, key: string) => { const list = await (await call('GET', path)).json() as any[]; return list?.[0]?.[key] ?? null; };
  return {
    async findContact(orgNo, memberNo) {
      return (orgNo ? await first(`/contacts?organizationNumber=${encodeURIComponent(orgNo)}`, 'contactId') : null)
        ?? await first(`/contacts?memberNumberString=${encodeURIComponent(memberNo)}`, 'contactId');
    },
    async createContact(b) { return idFrom(await call('POST', '/contacts', b)); },
    async findSale(no) { return first(`/sales?saleNumber=${encodeURIComponent(no)}`, 'saleId'); },
    async createSale(b) { return idFrom(await call('POST', '/sales', b)); },
    async createPayment(s, b) { return idFrom(await call('POST', `/sales/${s}/payments`, b)); },
    async deletePayment(s, p, d) { await call('DELETE', `/sales/${s}/payments/${p}?description=${encodeURIComponent(d)}`); },
    async settle(s, d) { await call('PATCH', `/sales/${s}/settled?settledDate=${d}`); }
  };
}
async function adapterFor(name: string): Promise<Adapter> {
  if (name !== 'live') return simulator;
  const f = await fikenSettings();
  if (!process.env.FIKEN_TOKEN || !f.companySlug) throw permanent('Fiken er ikke satt opp: FIKEN_TOKEN i .env og selskapets navn i Fiken (slug) under Fakturering › Innstillinger.');
  return live(f.companySlug);
}

/* ------------------------------ the outbox ------------------------------ */
/** Queue a job (inside the caller's transaction) when sending to Fiken is switched on. */
export async function enqueue(c: pg.PoolClient, kind: 'SALE' | 'PAYMENT' | 'PAYMENT_REVERSAL' | 'SETTLE', invoiceId: string, userId: string | null, paymentId: string | null = null) {
  if (!(await fikenSettings(c)).auto) return;
  await c.query('INSERT INTO fiken_sync (kind, invoice_id, payment_id, adapter, queued_by) VALUES ($1, $2, $3, $4, $5)', [kind, invoiceId, paymentId, adapterName(), userId]);
}

let running = false, timer: NodeJS.Timeout | null = null;
export function kick(delayMs = 0) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void work().catch(e => console.error('fiken:', e)); }, delayMs);
  timer.unref?.();
}
async function work() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const j = await one("SELECT * FROM fiken_sync WHERE status = 'QUEUED' AND next_try_at <= now() ORDER BY queued_at LIMIT 1");
      if (!j) break;
      await runJob(j);
    }
  } finally {
    running = false;
    const next = await one("SELECT extract(epoch FROM (min(next_try_at) - now())) * 1000 ms FROM fiken_sync WHERE status = 'QUEUED'");
    if (next?.ms != null) kick(Math.max(200, Number(next.ms)));
  }
}

const linkOf = async (type: string, id: string, adapter: string) => (await one('SELECT fiken_id FROM fiken_link WHERE object_type = $1 AND object_id = $2 AND adapter = $3', [type, id, adapter]))?.fiken_id ?? null;
const link = (type: string, id: string, fikenId: number, adapter: string) =>
  query('INSERT INTO fiken_link (object_type, object_id, fiken_id, adapter) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [type, id, fikenId, adapter]);
/** A payment or settlement waits for its sale: requeued while the sale job is still on its way. */
class Wait extends Error {}
async function saleIdOf(invoiceId: string, adapter: string) {
  const id = await linkOf('SALE', invoiceId, adapter);
  if (id) return Number(id);
  const pending = await one("SELECT status FROM fiken_sync WHERE kind = 'SALE' AND invoice_id = $1 AND status IN ('QUEUED', 'SENDING', 'FAILED') ORDER BY queued_at DESC LIMIT 1", [invoiceId]);
  if (pending?.status === 'QUEUED' || pending?.status === 'SENDING') throw new Wait();
  throw permanent('Fakturaen er ikke sendt til Fiken ennå. Send salget først.');
}

async function runJob(j: any) {
  await pool.query("UPDATE fiken_sync SET status = 'SENDING', attempts = attempts + 1 WHERE id = $1", [j.id]);
  const f = await fikenSettings();
  let request: any = null, response: any = null;
  try {
    const a = await adapterFor(j.adapter);
    const inv = await one('SELECT * FROM invoice WHERE id = $1', [j.invoice_id]);
    if (j.kind === 'SALE') {
      const existing = await linkOf('SALE', inv.id, j.adapter) ?? await a.findSale(String(inv.invoice_no));
      if (existing) { await link('SALE', inv.id, Number(existing), j.adapter); response = { saleId: Number(existing), alreadyThere: true }; }
      else {
        const b = inv.buyer ?? {};
        let customerId = await linkOf('CONTACT', inv.client_id, j.adapter);
        if (!customerId) {
          customerId = await a.findContact(b.orgNo ?? null, b.partnerNo) ?? await a.createContact(contactRequest(b));
          await link('CONTACT', inv.client_id, Number(customerId), j.adapter);
        }
        const lines = await query('SELECT * FROM invoice_line WHERE invoice_id = $1 AND removed_at IS NULL ORDER BY sort', [inv.id]);
        const bad = Object.entries(f.accounts).filter(([, v]) => !ACCOUNT_RE.test(String(v)));
        if (bad.length) throw permanent(`Kontoene for Fiken er ikke gyldige (${bad.map(([k]) => k).join(', ')}). Rett dem under Fakturering › Innstillinger.`);
        request = saleRequest(inv, lines, f, Number(customerId));
        const saleId = await a.createSale(request);
        await link('SALE', inv.id, saleId, j.adapter);
        response = { saleId, customerId: Number(customerId), deposit: Number(inv.deposit_applied) || undefined };
      }
    } else if (j.kind === 'PAYMENT') {
      const p = await one('SELECT * FROM invoice_payment WHERE id = $1', [j.payment_id]);
      if (p.reversed_at) { response = { skipped: 'reversed before it was sent' }; }
      else {
        if (!ACCOUNT_RE.test(f.paymentAccount ?? '')) throw permanent('Bankkontoen for innbetalinger i Fiken mangler (f.eks. 1920:10001). Fyll den ut under Fakturering › Innstillinger.');
        const saleId = await saleIdOf(inv.id, j.adapter);
        request = paymentRequest(p, f);
        const paymentId = await a.createPayment(saleId, request);
        await link('PAYMENT', p.id, paymentId, j.adapter);
        response = { saleId, paymentId };
      }
    } else if (j.kind === 'PAYMENT_REVERSAL') {
      const p = await one('SELECT * FROM invoice_payment WHERE id = $1', [j.payment_id]);
      const paymentId = await linkOf('PAYMENT', p.id, j.adapter);
      if (!paymentId) response = { skipped: 'the payment was never in Fiken' };
      else {
        const saleId = await saleIdOf(inv.id, j.adapter);
        request = { description: `Reversert i OdinAi: ${p.reversal_reason ?? ''}`.slice(0, 200) };
        await a.deletePayment(saleId, Number(paymentId), request.description);
        response = { saleId, paymentId: Number(paymentId), undone: true };
      }
    } else if (j.kind === 'SETTLE') {
      const saleId = await saleIdOf(inv.id, j.adapter);
      request = { settledDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' }) };
      await a.settle(saleId, request.settledDate);
      response = { saleId, settled: request.settledDate };
    }
    await tx(async c => {
      await c.query("UPDATE fiken_sync SET status = 'DONE', finished_at = now(), last_error = NULL, request = $2, response = $3 WHERE id = $1", [j.id, request && JSON.stringify(request), JSON.stringify(response)]);
      await audit(null, { action: 'FIKEN_SENT', objectType: 'INVOICE', objectId: j.invoice_id, detail: { job: j.id, kind: j.kind, adapter: j.adapter, ...response } }, c);
    });
  } catch (e: any) {
    if (e instanceof Wait) {
      await pool.query("UPDATE fiken_sync SET status = 'QUEUED', attempts = attempts - 1, next_try_at = now() + interval '2 seconds' WHERE id = $1", [j.id]);
      return;
    }
    const attempts = j.attempts + 1, message = String(e?.message ?? e).slice(0, 500);
    await tx(async c => {
      if (e?.permanent || attempts > RETRY.length) {
        await c.query("UPDATE fiken_sync SET status = 'FAILED', last_error = $2, finished_at = now(), request = $3 WHERE id = $1", [j.id, message, request && JSON.stringify(request)]);
        await audit(null, { action: 'FIKEN_FAILED', objectType: 'INVOICE', objectId: j.invoice_id, detail: { job: j.id, kind: j.kind, attempts, error: message } }, c);
      } else {
        await c.query("UPDATE fiken_sync SET status = 'QUEUED', last_error = $2, next_try_at = now() + make_interval(secs => $3) WHERE id = $1", [j.id, message, RETRY[attempts - 1]]);
      }
    });
  }
}

export const jobs = (invoiceId?: string) => query(`SELECT s.id, s.kind, s.invoice_id, s.payment_id, s.status, s.attempts, s.last_error, s.adapter, s.request, s.response, s.queued_at, s.finished_at,
    i.invoice_no, i.kind invoice_kind, c.legal_name client_name FROM fiken_sync s JOIN invoice i ON i.id = s.invoice_id JOIN business_partner c ON c.id = i.client_id
    ${invoiceId ? 'WHERE s.invoice_id = $1' : ''} ORDER BY s.queued_at DESC LIMIT 300`, invoiceId ? [invoiceId] : []);

export async function overview() {
  const f = await fikenSettings();
  const counts = await one(`SELECT count(*) FILTER (WHERE status IN ('QUEUED', 'SENDING')) waiting, count(*) FILTER (WHERE status = 'FAILED') failed FROM fiken_sync`);
  return { adapter: adapterName(), tokenSet: !!process.env.FIKEN_TOKEN, settings: f, gaps: fikenGaps(f), counts, jobs: await jobs() };
}

export async function retry(req: any, id: string) {
  const j = await one('SELECT * FROM fiken_sync WHERE id = $1', [id]);
  if (!j) fail(404, 'Fant ikke jobben.');
  if (j.status !== 'FAILED') fail(409, 'Bare en feilet jobb kan prøves igjen.');
  await pool.query("UPDATE fiken_sync SET status = 'QUEUED', attempts = 0, next_try_at = now(), finished_at = NULL, adapter = $2 WHERE id = $1", [id, adapterName()]);
  await audit(req, { action: 'FIKEN_RETRY', objectType: 'INVOICE', objectId: j.invoice_id, detail: { job: id, kind: j.kind } });
  kick();
  return overview();
}
export async function cancel(req: any, id: string, reason: unknown) {
  const j = await one('SELECT * FROM fiken_sync WHERE id = $1', [id]);
  if (!j) fail(404, 'Fant ikke jobben.');
  if (!['QUEUED', 'FAILED'].includes(j.status)) fail(409, 'Bare en jobb som venter eller har feilet, kan avbrytes.');
  const why = String(reason ?? '').trim();
  if (!why) fail(400, 'Oppgi hvorfor jobben avbrytes (f.eks. ført for hånd i Fiken).', 'REASON_REQUIRED');
  await pool.query("UPDATE fiken_sync SET status = 'CANCELLED', finished_at = now(), last_error = $2 WHERE id = $1", [id, `Avbrutt: ${why}`]);
  await audit(req, { action: 'FIKEN_CANCELLED', objectType: 'INVOICE', objectId: j.invoice_id, detail: { job: id, kind: j.kind, reason: why } });
  return overview();
}
/** Send everything issued that Fiken has not got (for invoices from before Fiken was switched on). */
export async function catchUp(req: any) {
  const n = await tx(async c => {
    const r = await c.query(`INSERT INTO fiken_sync (kind, invoice_id, adapter, queued_by)
        SELECT 'SALE', i.id, $1, $2 FROM invoice i WHERE i.status IN ('ISSUED', 'CREDITED')
          AND NOT EXISTS (SELECT 1 FROM fiken_link l WHERE l.object_type = 'SALE' AND l.object_id = i.id AND l.adapter = $1)
          AND NOT EXISTS (SELECT 1 FROM fiken_sync s WHERE s.kind = 'SALE' AND s.invoice_id = i.id AND s.status IN ('QUEUED', 'SENDING', 'FAILED'))`, [adapterName(), req.user.id]);
    await audit(req, { action: 'FIKEN_CATCH_UP', objectType: 'SETTINGS', objectId: 'fiken', detail: { queued: r.rowCount } }, c);
    return r.rowCount ?? 0;
  });
  kick();
  return { queued: n, ...(await overview()) };
}

export async function start() {
  await pool.query("UPDATE fiken_sync SET status = 'QUEUED', next_try_at = now() WHERE status = 'SENDING' AND adapter = 'simulator'");
  // Live: a job cut off while sending may have reached Fiken; the sale is looked up by number before it is sent again.
  await pool.query("UPDATE fiken_sync SET status = 'QUEUED', next_try_at = now() WHERE status = 'SENDING' AND kind = 'SALE'");
  await pool.query("UPDATE fiken_sync SET status = 'FAILED', last_error = 'Avbrutt under sending. Kontroller i Fiken før du prøver igjen.', finished_at = now() WHERE status = 'SENDING'");
  kick(1000);
}
