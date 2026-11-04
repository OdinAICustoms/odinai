import type { Request } from 'express';
import { one, query, tx, pool, type Db } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as docs from '../documents.js';

/**
 * RT100 permits (råvaretollavgift): Landbruksdirektoratet's decision letter grants a reduced rate per kg,
 * in two variants (TALL ordinary origin, TOES EEA origin) with their own skrivnummer, for a period, to a
 * NAMED company. One letter = one product; a product keeps earlier permits as history (a new decision
 * roughly every three years). A permit is never transferable between companies.
 *
 * The checks below are shown, never fixed silently (as in ODIN LINK 2.37).
 */
const WARN_DAYS = Number(process.env.RT_WARN_DAYS || 60);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const orgDigits = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-9);
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const rate = (v: unknown) => { const s = str(v); if (s == null) return null; const n = Number(s.replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0) fail(400, 'Satsen må være et tall som er null eller større.', 'RT_RATE'); return n; };
const date = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const who = (req: Request) => req.user!.id;

export type PermitStatus = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NOT_YET_VALID' | 'INACTIVE';
/** Status on a date: a declaration uses the permit in force on its declaration date. */
export function permitStatus(r: { valid_from: string; valid_to: string; active?: boolean }, on = today()): PermitStatus {
  if (r.active === false) return 'INACTIVE';
  if (on < r.valid_from) return 'NOT_YET_VALID';
  if (on > r.valid_to) return 'EXPIRED';
  if (r.valid_to <= addDays(on, WARN_DAYS)) return 'EXPIRING';
  return 'VALID';
}

const orgOf = async (partnerId: string | null, db: Db = pool) => partnerId ? (await one(`SELECT replace(identifier_value, ' ', '') v FROM bp_identifier
    WHERE partner_id = $1 AND identifier_type = 'ORG_NO' AND status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1`, [partnerId], db))?.v ?? null : null;

/** Consistency between a permit, its holder and its product. */
export async function checks(r: any, db: Db = pool): Promise<{ code: string; msg: string }[]> {
  const w: { code: string; msg: string }[] = [];
  if (!r.holder_org_no) w.push({ code: 'RT_NO_HOLDER_ORG', msg: 'Tillatelsen mangler innehaverens organisasjonsnummer fra vedtaksbrevet. Innehaveren kan da ikke kontrolleres mot importøren.' });
  if (r.holder_id && r.holder_org_no) {
    const org = await orgOf(r.holder_id, db);
    if (org && org !== orgDigits(r.holder_org_no)) w.push({ code: 'RT_HOLDER_ORG_DIFFERS', msg: `Organisasjonsnummeret i vedtaksbrevet (${r.holder_org_no}) er ikke innehaverens (${org}).` });
  }
  if (!r.product_id) { w.push({ code: 'RT_NO_PRODUCT', msg: 'Tillatelsen er ikke knyttet til et produkt.' }); return w; }
  const p = await one('SELECT owner_id, code FROM product WHERE id = $1', [r.product_id], db);
  if (p?.owner_id && r.holder_id && p.owner_id !== r.holder_id)
    w.push({ code: 'RT_HOLDER_NOT_OWNER', msg: 'Tillatelsens innehaver er ikke produktets klient (eier). En RT-tillatelse kan ikke overføres.' });
  if (p?.code && r.tariff_code && d8(p.code) !== d8(r.tariff_code))
    w.push({ code: 'RT_CODE_DIFFERS', msg: `Varenummeret på tillatelsen (${r.tariff_code}) er ikke det samme som produktets (${p.code}).` });
  const overlap = (await one<{ n: number }>(`SELECT COUNT(*) n FROM rt_permit WHERE product_id = $1 AND id <> $2 AND active AND valid_from <= $3 AND valid_to >= $4`,
    [r.product_id, r.id ?? '00000000-0000-0000-0000-000000000000', r.valid_to, r.valid_from], db))!.n;
  if (overlap) w.push({ code: 'RT_OVERLAP', msg: 'Produktet har en annen tillatelse med overlappende gyldighet. Den som gjelder på deklarasjonsdatoen brukes.' });
  return w;
}

const SELECT = `SELECT r.*, p.product_no, p.name product_label, p.code product_code, h.legal_name holder_label, h.partner_no holder_no
  FROM rt_permit r LEFT JOIN product p ON p.id = r.product_id LEFT JOIN business_partner h ON h.id = r.holder_id`;
async function decorate(rows: any[]) {
  return Promise.all(rows.map(async r => ({ ...r, status: permitStatus(r), warnings: await checks(r), documents: await docs.listFor('RT_PERMIT', r.id) })));
}
export const forProduct = async (productId: string) => decorate(await query(`${SELECT} WHERE r.product_id = $1 ORDER BY r.valid_to DESC`, [productId]));
export const forHolder = async (partnerId: string) => decorate(await query(`${SELECT} WHERE r.holder_id = $1 ORDER BY r.active DESC, r.valid_to DESC`, [partnerId]));
export async function get(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(404, 'Fant ikke tillatelsen.');
  const r = await one(`${SELECT} WHERE r.id = $1`, [id]);
  if (!r) fail(404, 'Fant ikke tillatelsen.');
  return (await decorate([r]))[0];
}

/** The RT permits list (Produkter › RT-tillatelser): search, status, holder, permits with no product. */
export async function list(f: Record<string, string | undefined> = {}) {
  const p: unknown[] = [], where: string[] = ['r.active'];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace(/\?/g, `$${p.length}`)); };
  if (f.holder) add('r.holder_id = ?', f.holder);
  if (f.unlinked === '1') where.push('r.product_id IS NULL');
  if (f.q) add(`(r.product_name ILIKE ? OR r.permit_no ILIKE ? OR r.case_ref ILIKE ? OR r.tariff_code LIKE ? OR p.product_no ILIKE ? OR h.legal_name ILIKE ?)`, `%${f.q}%`);
  const rows = await decorate(await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.valid_to DESC LIMIT 1000`, p));
  // A product's newest permit decides whether it needs attention; replaced permits are history.
  const latest = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) { const k = r.product_id ?? r.id; if (!seen.has(k)) { seen.add(k); latest.add(r.id); } }
  return rows.map(r => ({ ...r, latest: latest.has(r.id) })).filter(r => !f.status || r.status === f.status);
}

/** Permits that will soon stop applying (newest per product only). */
export async function expiring(days = 90) {
  const limit = addDays(today(), days);
  return (await list()).filter(r => r.latest && r.valid_to <= limit);
}

function cleanPermit(b: any) {
  const o = {
    product_id: str(b.product_id), holder_id: str(b.holder_id), holder_org_no: str(b.holder_org_no) ? orgDigits(b.holder_org_no) : null, holder_name: str(b.holder_name),
    product_name: str(b.product_name), tariff_code: str(b.tariff_code) ? d8(b.tariff_code) : null, case_ref: str(b.case_ref),
    skriv_tall: str(b.skriv_tall), rate_tall: rate(b.rate_tall), skriv_toes: str(b.skriv_toes), rate_toes: rate(b.rate_toes),
    valid_from: date(b.valid_from), valid_to: date(b.valid_to), notes: str(b.notes)
  };
  if (!o.product_name) fail(400, 'Produktnavnet fra vedtaksbrevet er påkrevd.', 'RT_NAME');
  if (!o.valid_from || !o.valid_to) fail(400, 'Gyldig fra og gyldig til er påkrevd.', 'RT_DATES');
  if (o.valid_to! < o.valid_from!) fail(400, 'Gyldig til er før gyldig fra.', 'RT_DATES');
  if (o.rate_tall == null && o.rate_toes == null) fail(400, 'Oppgi minst én sats (TALL eller TOES) fra vedtaksbrevet.', 'RT_NO_RATE');
  if (o.tariff_code && o.tariff_code.length !== 8) fail(400, 'Varenummeret på tillatelsen må ha 8 siffer.', 'RT_CODE');
  for (const k of ['product_id', 'holder_id'] as const) if (o[k] && !/^[0-9a-f-]{36}$/i.test(o[k]!)) fail(400, 'Ugyldig produkt eller innehaver.');
  return o;
}

/**
 * Register a decision. From a product card, the product's client is the holder and the product's name
 * and code are filled in; the holder's org. no. is taken from the partner card unless the letter says otherwise.
 */
export async function create(req: Request, b: any) {
  const pre: any = {};
  if (b.product_id) {
    const p = await one('SELECT id, owner_id, name, code, merged_into FROM product WHERE id = $1', [b.product_id]);
    if (!p) fail(404, 'Fant ikke produktet.');
    if (p!.merged_into) fail(409, 'Produktet er slått sammen med et annet. Velg produktet det ble slått inn i.', 'MERGED');
    Object.assign(pre, { holder_id: p!.owner_id, product_name: p!.name, tariff_code: p!.code });
  }
  const o = cleanPermit({ ...pre, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== '')) });
  if (!o.holder_id) fail(400, 'Velg innehaveren (klienten vedtaket er gitt til).', 'RT_HOLDER');
  const holder = await one('SELECT legal_name FROM business_partner WHERE id = $1 AND merged_into IS NULL', [o.holder_id]);
  if (!holder) fail(400, 'Innehaveren finnes ikke i Forretningspartner.');
  if (!o.holder_org_no) o.holder_org_no = await orgOf(o.holder_id);
  if (!o.holder_name) o.holder_name = holder!.legal_name;
  const id = await tx(async c => {
    const r = (await c.query(`INSERT INTO rt_permit (product_id, holder_id, holder_org_no, holder_name, product_name, tariff_code, case_ref,
        skriv_tall, rate_tall, skriv_toes, rate_toes, valid_from, valid_to, notes, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
      [o.product_id, o.holder_id, o.holder_org_no, o.holder_name, o.product_name, o.tariff_code, o.case_ref, o.skriv_tall, o.rate_tall,
        o.skriv_toes, o.rate_toes, o.valid_from, o.valid_to, o.notes, who(req)])).rows[0];
    if (o.product_id) await c.query('INSERT INTO product_history (product_id, field, new_value, basis, user_id) VALUES ($1, $2, $3, $4, $5)',
      [o.product_id, 'rt_permit', `${o.valid_from} – ${o.valid_to}`, o.case_ref, who(req)]);
    await audit(req, { action: 'RT_PERMIT_CREATED', objectType: 'PRODUCT', objectId: o.product_id ?? r.id, after: o, detail: { permit: r.id } }, c);
    return r.id as string;
  });
  const permit = await get(id);
  return { permit, warnings: permit.warnings };
}

/** Correct a typing error in a registered permit (a new decision is a new permit, not an edit). */
export async function update(req: Request, id: string, b: any) {
  const before = await get(id);
  const o = cleanPermit({ ...before, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) });
  await query(`UPDATE rt_permit SET product_id=$2, holder_id=$3, holder_org_no=$4, holder_name=$5, product_name=$6, tariff_code=$7, case_ref=$8,
      skriv_tall=$9, rate_tall=$10, skriv_toes=$11, rate_toes=$12, valid_from=$13, valid_to=$14, notes=$15, updated_at=now(), updated_by=$16 WHERE id = $1`,
    [id, o.product_id, o.holder_id, o.holder_org_no, o.holder_name, o.product_name, o.tariff_code, o.case_ref, o.skriv_tall, o.rate_tall,
      o.skriv_toes, o.rate_toes, o.valid_from, o.valid_to, o.notes, who(req)]);
  const pick = (x: any) => Object.fromEntries(Object.keys(o).map(k => [k, x[k] == null ? null : ['rate_tall', 'rate_toes'].includes(k) ? Number(x[k]) : x[k]]));
  await audit(req, { action: 'RT_PERMIT_CHANGED', objectType: 'PRODUCT', objectId: o.product_id ?? id, before: pick(before), after: pick(o), detail: { permit: id } });
  const permit = await get(id);
  return { permit, warnings: permit.warnings };
}

/** Withdraw a permit (revoked by Landbruksdirektoratet, registered by mistake). It stays as history. */
export async function deactivate(req: Request, id: string, reason: unknown) {
  const r = await get(id);
  if (!str(reason)) fail(400, 'Oppgi hvorfor tillatelsen trekkes tilbake.', 'RT_REASON');
  await query("UPDATE rt_permit SET active = false, notes = trim(both ' ' from coalesce(notes, '') || ' [Trukket tilbake ' || current_date || ': ' || $2 || ']'), updated_at = now(), updated_by = $3 WHERE id = $1", [id, str(reason), who(req)]);
  await audit(req, { action: 'RT_PERMIT_WITHDRAWN', objectType: 'PRODUCT', objectId: r.product_id ?? id, detail: { permit: id, reason: str(reason) } });
  return { permit: await get(id), warnings: [] };
}

/** Link a permit moved in without a product to the right product. */
export async function linkToProduct(req: Request, id: string, productId: string) {
  const r = await get(id);
  const p = await one('SELECT id, merged_into FROM product WHERE id = $1', [productId]);
  if (!p) fail(404, 'Fant ikke produktet.');
  if (p!.merged_into) fail(409, 'Produktet er slått sammen med et annet. Velg produktet det ble slått inn i.', 'MERGED');
  await query('UPDATE rt_permit SET product_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [id, productId, who(req)]);
  await audit(req, { action: 'RT_PERMIT_LINKED', objectType: 'PRODUCT', objectId: productId, detail: { permit: id, from: r.product_id } });
  const permit = await get(id);
  return { permit, warnings: permit.warnings };
}

/** The values a renewal starts from: the newest permit of the product, dated from the day after it ends. */
export async function renewalDefaults(productId: string) {
  const last = (await forProduct(productId)).find(r => r.active);    // a withdrawn permit is not renewed
  if (!last) return null;
  const from = addDays(last.valid_to, 1) > today() ? addDays(last.valid_to, 1) : today();
  return { product_id: productId, holder_id: last.holder_id, holder_org_no: last.holder_org_no, product_name: last.product_name, tariff_code: last.tariff_code,
    skriv_tall: last.skriv_tall, rate_tall: last.rate_tall, skriv_toes: last.skriv_toes, rate_toes: last.rate_toes, valid_from: from, valid_to: addDays(addDays(from, 365 * 3), -1) };
}

/** The permit for a product on a date (newest first). The declaration flow (phase 2) adds the holder check. */
export async function permitFor(productId: string, on = today()) {
  return one(`SELECT * FROM rt_permit WHERE product_id = $1 AND active AND valid_from <= $2 AND valid_to >= $2 ORDER BY valid_from DESC LIMIT 1`, [productId, on]);
}
