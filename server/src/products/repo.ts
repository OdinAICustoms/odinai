import type { Request } from 'express';
import type pg from 'pg';
import { one, query, tx, pool, type Db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, fail } from '../errors.js';
import * as docs from '../documents.js';
import * as RT from './rt.js';

export const STATUSES = ['DRAFT', 'REVIEW', 'CHECKED', 'EXPIRED', 'BLOCKED'] as const;
export const ID_TYPES = ['GTIN', 'CLIENT_ART', 'SUPPLIER_ART', 'NAME'] as const;
export const BASES = ['BKU', 'RULING', 'OTHER'] as const;
const FIELDS = ['name', 'descr', 'owner_id', 'supplier_id', 'code', 'origin', 'pref_basis', 'supp_unit', 'net_kg', 'gross_kg', 'price', 'currency',
  'basis', 'reference_no', 'valid_to', 'notes'] as const;

const today = () => new Date().toISOString().slice(0, 10);
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '');
export const normId = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s\-./]/g, '');
export const displayCode = (v: unknown) => { const d = d8(v); return d.length === 8 ? `${d.slice(0, 4)} ${d.slice(4, 6)} ${d.slice(6)}` : String(v ?? ''); };
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const numOrNull = (v: unknown) => { const s = str(v); if (s == null) return null; const n = Number(s.replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(n) || n < 0) fail(400, 'Vekt og pris må være tall som er null eller større.'); return n; };
const uuidOrNull = (v: unknown) => { const s = str(v); if (s && !/^[0-9a-f-]{36}$/i.test(s)) fail(400, 'Ugyldig partner.'); return s; };
const who = (req: Request) => req.user!.id;
const canCheck = (req: Request) => req.user!.perms.includes('product.check');

/** Inputs to stored form; only the fields present are returned. */
function clean(b: any) {
  const o: Record<string, any> = {};
  for (const k of FIELDS) if (b[k] !== undefined) o[k] = b[k];
  if ('name' in o) o.name = str(o.name);
  if ('descr' in o) o.descr = str(o.descr);
  if ('code' in o) { o.code = str(o.code) ? d8(o.code) : null; if (o.code && o.code.length !== 8) fail(400, 'Varenummer må ha 8 siffer.', 'CODE_FORMAT'); }
  if ('origin' in o) { o.origin = str(o.origin)?.toUpperCase().slice(0, 2) ?? null; if (o.origin && !/^[A-Z]{2}$/.test(o.origin)) fail(400, 'Opprinnelsesland må være en ISO-kode med to bokstaver.'); }
  if ('basis' in o) { o.basis = str(o.basis)?.toUpperCase() ?? null; if (o.basis && !(BASES as readonly string[]).includes(o.basis)) fail(400, 'Ukjent grunnlag (BKU, bindende uttalelse eller annet).'); }
  for (const k of ['net_kg', 'gross_kg', 'price'] as const) if (k in o) o[k] = numOrNull(o[k]);
  for (const k of ['owner_id', 'supplier_id'] as const) if (k in o) o[k] = uuidOrNull(o[k]);
  for (const k of ['pref_basis', 'supp_unit', 'currency', 'reference_no', 'notes'] as const) if (k in o) o[k] = str(o[k]);
  if ('currency' in o && o.currency) o.currency = o.currency.toUpperCase();
  if ('valid_to' in o) o.valid_to = str(o.valid_to) && /^\d{4}-\d{2}-\d{2}/.test(String(o.valid_to)) ? String(o.valid_to).slice(0, 10) : null;
  return o;
}
const inTariff = async (code: string, db: Db = pool) => {
  const loaded = (await one<{ n: number }>("SELECT COUNT(*) n FROM tariff WHERE level = 'Code'", [], db))!.n > 1000;
  return !loaded || !!(await one("SELECT 1 FROM tariff WHERE code = $1 AND level = 'Code'", [code], db));
};
const history = (c: Db, productId: string, field: string, oldV: unknown, newV: unknown, basis: string | null, userId: string | null) =>
  c.query('INSERT INTO product_history (product_id, field, old_value, new_value, basis, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [productId, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), basis, userId]);

async function requireProduct(id: string, db: Db = pool) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(404, 'Fant ikke produktet.');
  const p = await one('SELECT * FROM product WHERE id = $1', [id], db);
  if (!p) fail(404, 'Fant ikke produktet.');
  return p!;
}
async function requirePartner(id: string | null, label: string) {
  if (id && !(await one('SELECT 1 FROM business_partner WHERE id = $1 AND merged_into IS NULL', [id]))) fail(400, `${label} finnes ikke i Forretningspartner.`);
}
/** Does RT100 apply to this code (a published RT100 rate exists today)? */
export const rtRequired = async (code: string | null) =>
  !!code && !!(await one(`SELECT 1 FROM tariff_rate WHERE code = $1 AND duty_code = 'RT100' AND valid_from <= current_date AND (valid_to IS NULL OR valid_to >= current_date) LIMIT 1`, [code]));

/* ------------------------------ reading ------------------------------ */
export async function card(id: string) {
  const p = await requireProduct(id);
  const name = async (pid: string | null) => (pid ? (await one('SELECT legal_name, partner_no FROM business_partner WHERE id = $1', [pid])) : null);
  const [owner, supplier] = await Promise.all([name(p.owner_id), name(p.supplier_id)]);
  const tariff = p.code ? await one('SELECT display, text, path_text, supp_unit FROM tariff WHERE code = $1', [p.code]) : null;
  const identifiers = await query(`SELECT i.*, b.legal_name partner_name FROM product_identifier i LEFT JOIN business_partner b ON b.id = i.partner_id
      WHERE i.product_id = $1 ORDER BY i.type, i.value`, [id]);
  const hist = await query(`SELECT h.*, u.name user_name FROM product_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.product_id = $1 ORDER BY h.id DESC LIMIT 500`, [id]);
  const conflicts = await query('SELECT invoice_code, COUNT(*) n, MAX(at) last FROM product_hs_conflict WHERE product_id = $1 GROUP BY invoice_code ORDER BY n DESC', [id]);
  return {
    ...p, codeDisplay: p.code ? displayCode(p.code) : null, owner_name: owner?.legal_name ?? null, owner_no: owner?.partner_no ?? null,
    supplier_name: supplier?.legal_name ?? null, tariff_text: tariff?.path_text ?? tariff?.text ?? null, tariff_supp_unit: tariff?.supp_unit ?? null,
    inTariff: p.code ? await inTariff(p.code) : null, rtRequired: await rtRequired(p.code),
    identifiers, history: hist, conflicts, documents: await docs.listFor('PRODUCT', id), rtPermits: await RT.forProduct(id),
    mergedIntoNo: p.merged_into ? (await one('SELECT product_no FROM product WHERE id = $1', [p.merged_into]))?.product_no : null
  };
}

export async function list(f: Record<string, string | undefined> = {}) {
  const p: unknown[] = [], where = ['p.merged_into IS NULL'];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace(/\?/g, `$${p.length}`)); };
  if (f.inactive !== '1') where.push('p.active');
  if (f.owner) add('p.owner_id = ?', f.owner);
  if (f.supplier) add('p.supplier_id = ?', f.supplier);
  if (f.status) add('p.status = ?', f.status);
  if (f.code) add('p.code LIKE ?', d8(f.code) + '%');
  if (f.origin) add('p.origin = ?', f.origin.toUpperCase());
  if (f.bku === 'yes') where.push("p.basis = 'BKU'");
  if (f.bku === 'no') where.push("(p.basis IS NULL OR p.basis <> 'BKU')");
  if (f.rt === 'yes') where.push('EXISTS (SELECT 1 FROM rt_permit r WHERE r.product_id = p.id AND r.active)');
  if (f.rt === 'no') where.push('NOT EXISTS (SELECT 1 FROM rt_permit r WHERE r.product_id = p.id AND r.active)');
  if (f.rt === 'missing') where.push(`EXISTS (SELECT 1 FROM tariff_rate t WHERE t.code = p.code AND t.duty_code = 'RT100' AND (t.valid_to IS NULL OR t.valid_to >= current_date))
      AND NOT EXISTS (SELECT 1 FROM rt_permit r WHERE r.product_id = p.id AND r.active AND r.valid_from <= current_date AND r.valid_to >= current_date)`);
  if (f.expiring) add(`p.valid_to IS NOT NULL AND p.valid_to >= current_date AND p.valid_to <= current_date + ?::int`, Number(f.expiring) || 90);
  if (f.q) {
    p.push(`%${f.q}%`, `%${normId(f.q)}%`);
    where.push(`(p.name ILIKE $${p.length - 1} OR p.descr ILIKE $${p.length - 1} OR p.product_no ILIKE $${p.length - 1} OR p.code LIKE $${p.length}
      OR EXISTS (SELECT 1 FROM product_identifier i WHERE i.product_id = p.id AND (i.value ILIKE $${p.length - 1} OR i.norm LIKE $${p.length})))`);
  }
  return query(`SELECT p.id, p.product_no, p.name, p.code, p.origin, p.status, p.basis, p.reference_no, p.valid_to, p.active, p.created_from, p.owner_id,
      o.legal_name owner_name, s.legal_name supplier_name,
      (SELECT COUNT(*) FROM product_identifier i WHERE i.product_id = p.id) id_count,
      (SELECT string_agg(value, ', ' ORDER BY type) FROM product_identifier i WHERE i.product_id = p.id AND i.type IN ('CLIENT_ART', 'GTIN')) ids,
      EXISTS (SELECT 1 FROM tariff_rate t WHERE t.code = p.code AND t.duty_code = 'RT100' AND (t.valid_to IS NULL OR t.valid_to >= current_date)) rt_required,
      (SELECT MAX(valid_to) FROM rt_permit r WHERE r.product_id = p.id AND r.active AND r.valid_from <= current_date) rt_valid_to
    FROM product p LEFT JOIN business_partner o ON o.id = p.owner_id LEFT JOIN business_partner s ON s.id = p.supplier_id
    WHERE ${where.join(' AND ')} ORDER BY p.product_no DESC LIMIT ${Math.min(Number(f.limit) || 500, 5000)}`, p);
}

/** Work lists: what needs a person. */
export async function worklists() {
  const base = `SELECT p.id, p.product_no, p.name, p.code, p.status, p.valid_to, o.legal_name owner_name FROM product p
    LEFT JOIN business_partner o ON o.id = p.owner_id WHERE p.merged_into IS NULL AND p.active`;
  return {
    needsChecking: await query(`${base} AND p.status IN ('DRAFT', 'REVIEW') ORDER BY p.created_at`),
    expiringSoon: await query(`${base} AND p.valid_to BETWEEN current_date AND current_date + 90 ORDER BY p.valid_to`),
    conflicts: await query(`${base} AND p.id IN (SELECT product_id FROM product_hs_conflict GROUP BY product_id HAVING COUNT(*) >= 2) ORDER BY p.name`),
    tariffChange: await query(`${base} AND p.status = 'EXPIRED' AND p.status_reason LIKE 'TARIFF%' ORDER BY p.name`),
    newFromImports: await query(`${base} AND p.created_from IN ('IMPORT', 'AI') AND p.status = 'DRAFT' ORDER BY p.created_at DESC`),
    rtMissing: await list({ rt: 'missing', limit: '500' })
  };
}

/**
 * The register product for an invoice line: GTIN first (global), then the client's article number,
 * then the supplier's. Another client's product is never used.
 */
export async function match(l: { gtin?: string; clientArt?: string; supplierArt?: string; ownerId?: string | null; supplierId?: string | null }) {
  const by = async (type: string, value: string | undefined, partnerId: string | null | undefined) => {
    const norm = type === 'GTIN' ? d8(value) : normId(value);
    if (!norm) return null;
    const rows = await query(`SELECT p.* FROM product_identifier i JOIN product p ON p.id = i.product_id
        WHERE i.type = $1 AND i.norm = $2 AND p.merged_into IS NULL AND p.active ${type === 'GTIN' ? '' : 'AND (i.partner_id = $3 OR i.partner_id IS NULL)'}
        ORDER BY (i.partner_id IS NOT NULL) DESC`, type === 'GTIN' ? [type, norm] : [type, norm, partnerId ?? null]);
    return rows.find(p => !l.ownerId || !p.owner_id || p.owner_id === l.ownerId) ?? null;
  };
  for (const [type, v, partner] of [['GTIN', l.gtin, null], ['CLIENT_ART', l.clientArt, l.ownerId], ['SUPPLIER_ART', l.supplierArt, l.supplierId]] as const) {
    const p = await by(type, v, partner);
    if (p) return { product: p, by: type };
  }
  return null;
}

/* ------------------------------ writing ------------------------------ */
async function addIdentifierIn(c: Db, productId: string, type: string, value: unknown, partnerId: string | null, source: string, userId: string | null) {
  if (!(ID_TYPES as readonly string[]).includes(type)) fail(400, 'Ukjent identifikatortype.');
  const v = str(value); if (!v) fail(400, 'Verdien mangler.');
  const norm = type === 'GTIN' ? d8(v) : normId(v);
  if (type === 'GTIN' && !/^\d{8,14}$/.test(norm)) fail(400, 'GTIN/EAN har 8–14 siffer.', 'GTIN_FORMAT');
  const pid = type === 'GTIN' ? null : partnerId;
  const dup = (await c.query(`SELECT i.product_id, p.product_no FROM product_identifier i JOIN product p ON p.id = i.product_id
      WHERE i.type = $1 AND i.norm = $2 AND i.partner_id IS NOT DISTINCT FROM $3 AND p.merged_into IS NULL`, [type, norm, pid])).rows[0];
  if (dup?.product_id === productId) return null;
  if (dup && type !== 'NAME') fail(409, `${type === 'GTIN' ? 'GTIN' : 'Artikkelnummeret'} ${v} er allerede registrert på ${dup.product_no}.`, 'IDENTIFIER_TAKEN');
  await c.query('INSERT INTO product_identifier (product_id, type, value, norm, partner_id, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [productId, type, v, norm, pid, source, userId]);
  await history(c, productId, `identifier.${type}`, null, v, source, userId);
  return true;
}

export async function create(req: Request, b: any, from = 'MANUAL') {
  const o = clean(b);
  if (!o.name && !o.descr) fail(400, 'Produktnavn er påkrevd.', 'NAME_REQUIRED');
  await requirePartner(o.owner_id ?? null, 'Klienten');
  await requirePartner(o.supplier_id ?? null, 'Leverandøren');
  const warnings: { msg: string }[] = [];
  if (o.code && !(await inTariff(o.code))) warnings.push({ msg: `Varenummer ${displayCode(o.code)} finnes ikke i gjeldende tolltariff.` });
  const id = await tx(async c => {
    const p = (await c.query(`INSERT INTO product (owner_id, supplier_id, name, descr, code, origin, pref_basis, supp_unit, net_kg, gross_kg, price, currency,
        basis, reference_no, valid_to, notes, created_from, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING id`,
      [o.owner_id ?? null, o.supplier_id ?? null, o.name ?? o.descr, o.descr ?? o.name, o.code ?? null, o.origin ?? null, o.pref_basis ?? null, o.supp_unit ?? null,
        o.net_kg ?? null, o.gross_kg ?? null, o.price ?? null, o.currency ?? null, o.basis ?? null, o.reference_no ?? null, o.valid_to ?? null, o.notes ?? null, from, who(req)])).rows[0];
    await history(c, p.id, 'created', null, from, null, who(req));
    if (o.code) await history(c, p.id, 'code', null, o.code, 'Opprettet', who(req));
    for (const i of Array.isArray(b.identifiers) ? b.identifiers : [])
      await addIdentifierIn(c, p.id, String(i.type).toUpperCase(), i.value, i.type === 'CLIENT_ART' ? (i.partner_id ?? o.owner_id ?? null) : i.type === 'SUPPLIER_ART' ? (i.partner_id ?? o.supplier_id ?? null) : (i.partner_id ?? null), i.source ?? from, who(req));
    await audit(req, { action: 'PRODUCT_CREATED', objectType: 'PRODUCT', objectId: p.id, after: o, detail: { from } }, c);
    return p.id as string;
  });
  return { product: await card(id), warnings };
}

/** Change fields (version-checked). A code change needs a basis and sends a checked product back to review. */
export async function update(req: Request, id: string, b: any) {
  const p = await requireProduct(id);
  if (p.merged_into) fail(409, 'Produktet er slått sammen med et annet.', 'MERGED');
  if (b.version != null && Number(b.version) !== p.version) fail(409, 'Produktet er endret av en annen bruker. Last inn på nytt før du lagrer.', 'VERSION');
  const o = clean(b);
  if ('name' in o && !o.name) fail(400, 'Produktnavn er påkrevd.', 'NAME_REQUIRED');
  if ('owner_id' in o) await requirePartner(o.owner_id, 'Klienten');
  if ('supplier_id' in o) await requirePartner(o.supplier_id, 'Leverandøren');
  const same = (k: string, v: unknown) => (p[k] == null ? '' : k.endsWith('_kg') || k === 'price' ? String(Number(p[k])) : String(p[k])) === (v == null ? '' : String(v));
  const changes = Object.entries(o).filter(([k, v]) => !same(k, v));
  if (!changes.length) return { product: await card(id), warnings: [] };
  const codeChange = changes.find(([k]) => k === 'code');
  const basis = str(b.change_basis);
  if (codeChange && !basis) fail(400, 'Endring av varenummer krever et grunnlag (f.eks. BKU-nummer eller begrunnelse).', 'BASIS_REQUIRED');
  const warnings: { msg: string }[] = [];
  if (codeChange?.[1] && !(await inTariff(String(codeChange[1])))) warnings.push({ msg: `Varenummer ${displayCode(codeChange[1])} finnes ikke i gjeldende tolltariff.` });
  await tx(async c => {
    await c.query(`UPDATE product SET ${changes.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${changes.length + 2} WHERE id = $1`,
      [id, ...changes.map(([, v]) => v), who(req)]);
    for (const [k, v] of changes) await history(c, id, k, p[k], v, k === 'code' ? basis : null, who(req));
    if (codeChange && p.status === 'CHECKED') {
      await c.query("UPDATE product SET status = 'REVIEW', checked_by = NULL, checked_at = NULL WHERE id = $1", [id]);
      await history(c, id, 'status', 'CHECKED', 'REVIEW', 'Varenummer endret', who(req));
      warnings.push({ msg: 'Varenummeret er endret, så produktet må kontrolleres på nytt.' });
    }
    await audit(req, { action: codeChange ? 'PRODUCT_CODE_CHANGED' : 'PRODUCT_CHANGED', objectType: 'PRODUCT', objectId: id,
      before: Object.fromEntries(changes.map(([k]) => [k, p[k]])), after: Object.fromEntries(changes), detail: codeChange ? { basis } : undefined }, c);
  });
  return { product: await card(id), warnings };
}

/** Status workflow. CHECKED needs an 8-digit code in today's tariff and a documented basis. */
export async function setStatus(req: Request, id: string, b: any) {
  const p = await requireProduct(id);
  const status = String(b.status || '').toUpperCase();
  if (!(STATUSES as readonly string[]).includes(status)) fail(400, 'Ukjent status.');
  if (p.merged_into) fail(409, 'Produktet er slått sammen med et annet.', 'MERGED');
  const basis = str(b.basis)?.toUpperCase() ?? null, ref = str(b.reference_no), reason = str(b.reason);
  if (basis && !(BASES as readonly string[]).includes(basis)) fail(400, 'Ukjent grunnlag.');
  if (status === 'CHECKED') {
    if (!canCheck(req)) fail(403, 'Du har ikke rettighet til å merke produkter som kontrollert.', 'NO_PERM');
    if (!p.code || p.code.length !== 8) fail(400, 'Et kontrollert produkt må ha et åttesifret varenummer.', 'CHECK_NO_CODE');
    if (!(await inTariff(p.code))) fail(400, `Varenummer ${displayCode(p.code)} finnes ikke i gjeldende tolltariff.`, 'CHECK_NOT_IN_TARIFF');
    const bas = basis ?? p.basis;
    if (!bas) fail(400, 'Oppgi grunnlaget for klassifiseringen (BKU, bindende uttalelse eller annet).', 'CHECK_NO_BASIS');
    if (bas === 'BKU' && !(ref ?? p.reference_no)) fail(400, 'Oppgi BKU-nummeret.', 'CHECK_NO_BKU');
  }
  if (status === 'BLOCKED' && !reason) fail(400, 'Oppgi hvorfor produktet blokkeres.', 'BLOCK_REASON');
  await tx(async c => {
    await c.query(`UPDATE product SET status = $2, status_reason = $3, basis = COALESCE($4, basis), reference_no = COALESCE($5, reference_no),
        checked_by = CASE WHEN $2 = 'CHECKED' THEN $6::uuid ELSE checked_by END, checked_at = CASE WHEN $2 = 'CHECKED' THEN now() ELSE checked_at END,
        version = version + 1, updated_at = now(), updated_by = $6 WHERE id = $1`, [id, status, reason, basis, ref, who(req)]);
    await history(c, id, 'status', p.status, status, reason ?? basis ?? null, who(req));
    await audit(req, { action: 'PRODUCT_STATUS', objectType: 'PRODUCT', objectId: id, before: { status: p.status }, after: { status }, detail: { basis, reference_no: ref, reason } }, c);
  });
  return { product: await card(id), warnings: [] };
}

export async function addIdentifier(req: Request, id: string, b: any) {
  const p = await requireProduct(id);
  const type = String(b.type || '').toUpperCase();
  const partner = type === 'CLIENT_ART' ? (uuidOrNull(b.partner_id) ?? p.owner_id) : type === 'SUPPLIER_ART' ? (uuidOrNull(b.partner_id) ?? p.supplier_id) : null;
  if (type === 'SUPPLIER_ART' && !partner) fail(400, 'Velg leverandøren som eier artikkelnummeret (eller sett leverandør på produktet).', 'SUPPLIER_REQUIRED');
  await tx(async c => {
    await addIdentifierIn(c, id, type, b.value, partner, 'MANUAL', who(req));
    await c.query('UPDATE product SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [id, who(req)]);
    await audit(req, { action: 'PRODUCT_IDENTIFIER_ADDED', objectType: 'PRODUCT', objectId: id, after: { type, value: str(b.value) } }, c);
  });
  return { product: await card(id), warnings: [] };
}
export async function removeIdentifier(req: Request, id: string, identId: string) {
  const i = await one('SELECT * FROM product_identifier WHERE id = $1 AND product_id = $2', [identId, id]);
  if (!i) fail(404, 'Fant ikke identifikatoren.');
  await tx(async c => {
    await c.query('DELETE FROM product_identifier WHERE id = $1', [identId]);
    await history(c, id, `identifier.${i!.type}`, i!.value, null, 'Fjernet', who(req));
    await audit(req, { action: 'PRODUCT_IDENTIFIER_REMOVED', objectType: 'PRODUCT', objectId: id, before: { type: i!.type, value: i!.value } }, c);
  });
  return { product: await card(id), warnings: [] };
}

export async function setActive(req: Request, id: string, active: boolean) {
  const p = await requireProduct(id);
  await tx(async c => {
    await c.query('UPDATE product SET active = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [id, active, who(req)]);
    await history(c, id, 'active', p.active, active, null, who(req));
    await audit(req, { action: active ? 'PRODUCT_REACTIVATED' : 'PRODUCT_DEACTIVATED', objectType: 'PRODUCT', objectId: id }, c);
  });
  return { product: await card(id), warnings: [] };
}

/** Merge a duplicate into the product kept: identifiers, documents, history and RT permits move. */
export async function merge(req: Request, sourceId: string, targetId: string) {
  if (sourceId === targetId) fail(400, 'Velg to forskjellige produkter.');
  const s = await requireProduct(sourceId), t = await requireProduct(targetId);
  if (s.merged_into || t.merged_into) fail(409, 'Et av produktene er allerede slått sammen.', 'MERGED');
  await tx(async (c: pg.PoolClient) => {
    for (const i of (await c.query('SELECT * FROM product_identifier WHERE product_id = $1', [sourceId])).rows) {
      const clash = (await c.query('SELECT 1 FROM product_identifier WHERE product_id = $1 AND type = $2 AND norm = $3 AND partner_id IS NOT DISTINCT FROM $4', [targetId, i.type, i.norm, i.partner_id])).rowCount;
      if (clash) await c.query('DELETE FROM product_identifier WHERE id = $1', [i.id]);
      else await c.query('UPDATE product_identifier SET product_id = $2 WHERE id = $1', [i.id, targetId]);
    }
    await c.query("UPDATE document SET owner_id = $2 WHERE owner_type = 'PRODUCT' AND owner_id = $1", [sourceId, targetId]);
    await c.query('UPDATE product_history SET product_id = $2 WHERE product_id = $1', [sourceId, targetId]);
    await c.query('UPDATE product_hs_conflict SET product_id = $2 WHERE product_id = $1', [sourceId, targetId]);
    await c.query('UPDATE rt_permit SET product_id = $2, updated_at = now() WHERE product_id = $1', [sourceId, targetId]);
    await c.query('UPDATE product SET merged_into = $2, active = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [sourceId, targetId, who(req)]);
    await history(c, targetId, 'merged', s.product_no, t.product_no, null, who(req));
    await audit(req, { action: 'PRODUCT_MERGED', objectType: 'PRODUCT', objectId: targetId, detail: { from: s.product_no } }, c);
    await audit(req, { action: 'PRODUCT_MERGED', objectType: 'PRODUCT', objectId: sourceId, detail: { into: t.product_no } }, c);
  });
  return { product: await card(targetId), warnings: [] };
}

/**
 * Daily, after the reference data: products whose valid-to has passed, or whose code has left the tariff,
 * become EXPIRED (they must be checked again before use).
 */
export async function expireCheck() {
  const loaded = (await one<{ n: number }>("SELECT COUNT(*) n FROM tariff WHERE level = 'Code'"))!.n > 1000;
  const rows = await query(`SELECT p.id, p.status, p.code, p.valid_to,
      CASE WHEN p.valid_to < current_date THEN 'VALID_TO ' || p.valid_to
           WHEN $1 AND p.code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tariff t WHERE t.code = p.code AND t.level = 'Code') THEN 'TARIFF ' || p.code || ' finnes ikke lenger i tolltariffen' END reason
    FROM product p WHERE p.merged_into IS NULL AND p.active AND p.status IN ('CHECKED', 'REVIEW', 'DRAFT')`, [loaded]);
  let n = 0;
  for (const r of rows.filter(r => r.reason)) {
    await tx(async c => {
      await c.query("UPDATE product SET status = 'EXPIRED', status_reason = $2, version = version + 1, updated_at = now() WHERE id = $1", [r.id, r.reason]);
      await history(c, r.id, 'status', r.status, 'EXPIRED', r.reason, null);
      await audit(null, { action: 'PRODUCT_STATUS', objectType: 'PRODUCT', objectId: r.id, before: { status: r.status }, after: { status: 'EXPIRED' }, detail: { reason: r.reason } }, c);
    });
    n++;
  }
  return n;
}

/** An invoice showed another code than the checked one (fed by the declaration flow in phase 2). */
export const recordConflict = (productId: string, invoiceCode: string, reference?: string) =>
  query('INSERT INTO product_hs_conflict (product_id, invoice_code, reference) VALUES ($1,$2,$3)', [productId, d8(invoiceCode), reference ?? null]);

export { HttpError };
