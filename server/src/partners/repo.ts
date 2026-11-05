import type { Request } from 'express';
import type pg from 'pg';
import { one, query, tx, pool, type Db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, fail } from '../errors.js';
import * as R from './rules.js';
import * as brreg from './brreg.js';
import * as eori from './eori.js';

const today = () => new Date().toISOString().slice(0, 10);
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const date = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
const bool = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
const upper = (v: unknown) => str(v)?.toUpperCase() ?? null;
const throwFindings = (f: R.Finding[]) => {
  const e = f.filter(x => x.lvl === 'err');
  if (e.length) throw Object.assign(new HttpError(400, e.map(x => x.msg).join(' '), e[0].rule), { findings: f });
  return f.filter(x => x.lvl === 'warn');
};
const who = (req: Request) => req.user!.id;

/* ------------------------------ child kinds ------------------------------ */
// The dated rows on a partner card. Each is added, changed, or ended (never deleted).
type Kind = 'addresses' | 'identifiers' | 'roles' | 'contacts' | 'credit';
const KINDS: Record<Kind, { table: string; fields: string[]; norm: (b: any) => any; check: (row: any, others: any[]) => R.Finding[] }> = {
  addresses: {
    table: 'bp_address', fields: ['address_type', 'address_name', 'street', 'postal_code', 'city', 'region', 'country_code', 'location_code', 'is_standard', 'valid_from', 'valid_to'],
    norm: b => ({ address_type: upper(b.address_type), address_name: str(b.address_name), street: str(b.street), postal_code: str(b.postal_code), city: str(b.city),
      region: str(b.region), country_code: upper(b.country_code), location_code: str(b.location_code), is_standard: bool(b.is_standard), valid_from: date(b.valid_from), valid_to: date(b.valid_to) }),
    check: (r, o) => R.checkAddress(r, o)
  },
  identifiers: {
    table: 'bp_identifier', fields: ['identifier_type', 'identifier_value', 'issuing_country', 'is_primary', 'valid_from', 'valid_to'],
    norm: b => {
      const t = upper(b.identifier_type);
      let v = str(b.identifier_value);
      if (v && (t === 'ORG_NO' || t === 'PERSON_NO')) v = R.digits(v);
      if (v && (t === 'EORI' || t === 'VAT_NO')) v = v.replace(/\s/g, '').toUpperCase();
      return { identifier_type: t, identifier_value: v, issuing_country: upper(b.issuing_country) ?? (t === 'ORG_NO' || t === 'PERSON_NO' ? 'NO' : null),
        is_primary: bool(b.is_primary), valid_from: date(b.valid_from), valid_to: date(b.valid_to) };
    },
    check: r => R.checkIdentifier(r)
  },
  roles: {
    table: 'bp_role', fields: ['role_code', 'valid_from', 'valid_to', 'notes'],
    norm: b => ({ role_code: upper(b.role_code), valid_from: date(b.valid_from), valid_to: date(b.valid_to), notes: str(b.notes) }),
    check: (r, o) => {
      const f = R.checkRole(r);
      if (o.some(x => x.id !== r.id && x.role_code === r.role_code && x.status === 'ACTIVE' && R.overlaps(x, r)))
        f.push({ lvl: 'err', rule: 'ROLE_DUPLICATE', msg: 'Partneren har allerede denne rollen i samme periode.' });
      return f;
    }
  },
  contacts: {
    table: 'bp_contact', fields: ['contact_type', 'contact_name', 'department', 'email', 'telephone', 'is_primary', 'clearance_mail'],
    norm: b => ({ contact_type: upper(b.contact_type) ?? 'GENERAL', contact_name: str(b.contact_name), department: str(b.department), email: str(b.email)?.toLowerCase() ?? null,
      telephone: str(b.telephone), is_primary: bool(b.is_primary), clearance_mail: bool(b.clearance_mail) }),
    check: r => R.checkContact(r)
  },
  credit: {
    table: 'bp_credit_account', fields: ['account', 'payment_type', 'valid_to'],
    norm: b => ({ account: str(b.account)?.replace(/\s/g, '') ?? null, payment_type: upper(b.payment_type) ?? 'TOLLKREDITT', valid_to: date(b.valid_to) }),
    check: r => R.checkCredit(r)
  }
};
export const isKind = (k: string): k is Kind => Object.prototype.hasOwnProperty.call(KINDS, k);

/* ------------------------------ reading ------------------------------ */
async function requirePartner(id: string, db: Db = pool) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(404, 'Fant ikke forretningspartneren.');
  const p = await one('SELECT * FROM business_partner WHERE id = $1', [id], db);
  if (!p) fail(404, 'Fant ikke forretningspartneren.');
  return p!;
}
const primaryId = (ids: any[], type: string) =>
  (ids.filter(i => i.identifier_type === type && i.status === 'ACTIVE').sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0] || {}).identifier_value ?? null;
export const formatAddress = (a: any) => (a ? [a.street, [a.postal_code, a.city].filter(Boolean).join(' '), a.country_code !== 'NO' ? a.country_code : null].filter(Boolean).join(', ') : '');
const standardAddress = (addrs: any[], d = today()) =>
  addrs.find(a => a.is_standard && R.inForce(a, d)) ?? addrs.find(a => a.address_type === 'REGISTERED' && R.inForce(a, d)) ?? addrs.find(a => R.inForce(a, d)) ?? null;

/** The full partner card. */
export async function get(id: string) {
  const p = await requirePartner(id);
  const [addresses, identifiers, roles, contacts, credit] = await Promise.all((['addresses', 'identifiers', 'roles', 'contacts', 'credit'] as Kind[]).map(k =>
    query(`SELECT * FROM ${KINDS[k].table} WHERE partner_id = $1 ORDER BY status, ${k === 'addresses' ? 'is_standard DESC, address_type' : k === 'roles' ? 'role_code' : k === 'credit' ? 'account' : k === 'identifiers' ? 'identifier_type, is_primary DESC' : 'is_primary DESC, contact_name'}`, [id])));
  const fullmakt = await query(`SELECT f.*, r.legal_name rep_name, r.partner_no rep_no, t.legal_name party_name, t.partner_no party_no
      FROM bp_fullmakt f JOIN business_partner r ON r.id = f.representative_id JOIN business_partner t ON t.id = f.partner_id
      WHERE f.partner_id = $1 OR f.representative_id = $1 ORDER BY f.status, f.valid_from DESC`, [id]);
  const relationships = await query(`SELECT r.*, s.legal_name source_name, s.partner_no source_no, t.legal_name target_name, t.partner_no target_no
      FROM bp_relationship r JOIN business_partner s ON s.id = r.source_partner_id JOIN business_partner t ON t.id = r.target_partner_id
      WHERE r.source_partner_id = $1 OR r.target_partner_id = $1 ORDER BY r.status, r.relationship_type`, [id]);
  const prices = await query(`SELECT b.*, i.name_no, i.name_en, i.unit, u.name locked_by_name FROM bp_price b JOIN price_item i ON i.code = b.item_code
      LEFT JOIN users u ON u.id = b.locked_by WHERE b.partner_id = $1 ORDER BY i.sort, b.valid_from DESC`, [id]);
  const invoicing = await one('SELECT * FROM bp_invoicing WHERE partner_id = $1', [id]);
  const registry = await one('SELECT * FROM bp_registry WHERE partner_id = $1', [id]);
  const orgNo = primaryId(identifiers, 'ORG_NO');
  const duplicates = orgNo ? await query(`SELECT DISTINCT p.id, p.partner_no, p.legal_name FROM bp_identifier i JOIN business_partner p ON p.id = i.partner_id
      WHERE i.identifier_type = 'ORG_NO' AND i.status = 'ACTIVE' AND replace(i.identifier_value, ' ', '') = $1 AND p.id <> $2 AND p.merged_into IS NULL`, [orgNo, id]) : [];
  const std = standardAddress(addresses);
  const d = today();
  return {
    ...p, addresses, identifiers: identifiers.map(i => i.identifier_type === 'PERSON_NO' ? { ...i, identifier_value: R.maskPersonNo(i.identifier_value) } : i),
    roles, contacts, credit, fullmakt, relationships, prices, invoicing, registry, duplicates,
    orgNo, eori: primaryId(identifiers, 'EORI'), vatNo: primaryId(identifiers, 'VAT_NO'),
    activeRoles: [...new Set(roles.filter(r => R.inForce(r, d)).map(r => r.role_code))], standardAddress: std, addressText: formatAddress(std),
    mergedIntoNo: p.merged_into ? (await one('SELECT partner_no FROM business_partner WHERE id = $1', [p.merged_into]))?.partner_no : null
  };
}

/** The partner list with filters; q matches name, partner no. and any identifier. */
export async function list(f: { q?: string; role?: string; client?: string; status?: string; country?: string } = {}) {
  const p: unknown[] = [], where: string[] = ['p.merged_into IS NULL'];
  const add = (sql: string, ...v: unknown[]) => { const s = v.reduce<string>((acc, x) => { p.push(x); return acc.replace('?', `$${p.length}`); }, sql); where.push(s); };
  const status = f.status === 'ALL' ? null : (f.status || 'ACTIVE');
  if (status) add('p.status = ?', status);
  if (f.client === '1') where.push('p.is_client');
  if (f.country) add('p.registration_country = ?', f.country.toUpperCase());
  if (f.role) add(`EXISTS (SELECT 1 FROM bp_role r WHERE r.partner_id = p.id AND r.role_code = ? AND r.status = 'ACTIVE' AND (r.valid_to IS NULL OR r.valid_to >= current_date))`, f.role.toUpperCase());
  const q = String(f.q || '').trim();
  if (q) add(`(p.search_name LIKE ? OR upper(p.partner_no) LIKE ? OR EXISTS (SELECT 1 FROM bp_identifier i WHERE i.partner_id = p.id AND i.identifier_type <> 'PERSON_NO'
      AND upper(replace(i.identifier_value, ' ', '')) LIKE ?))`, `%${R.searchName(q)}%`, `%${q.toUpperCase()}%`, `%${q.replace(/\s/g, '').toUpperCase()}%`);
  return query(`SELECT p.id, p.partner_no, p.legal_name, p.category, p.registration_country, p.is_client, p.status, p.updated_at,
      (SELECT identifier_value FROM bp_identifier i WHERE i.partner_id = p.id AND i.identifier_type = 'ORG_NO' AND i.status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1) org_no,
      (SELECT identifier_value FROM bp_identifier i WHERE i.partner_id = p.id AND i.identifier_type = 'EORI' AND i.status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1) eori,
      (SELECT check_status FROM bp_identifier i WHERE i.partner_id = p.id AND i.identifier_type = 'EORI' AND i.status = 'ACTIVE' ORDER BY is_primary DESC LIMIT 1) eori_check,
      ARRAY(SELECT DISTINCT role_code FROM bp_role r WHERE r.partner_id = p.id AND r.status = 'ACTIVE' AND (r.valid_to IS NULL OR r.valid_to >= current_date) ORDER BY 1) roles,
      (SELECT concat_ws(', ', a.street, concat_ws(' ', a.postal_code, a.city)) FROM bp_address a WHERE a.partner_id = p.id AND a.status = 'ACTIVE'
         ORDER BY a.is_standard DESC, (a.address_type = 'REGISTERED') DESC LIMIT 1) address,
      (r.bankrupt OR r.winding_up OR r.forced_dissolution OR r.deleted) registry_warning
    FROM business_partner p LEFT JOIN bp_registry r ON r.partner_id = p.id
    WHERE ${where.join(' AND ')} ORDER BY p.legal_name LIMIT 500`, p);
}

export async function counters() {
  const r = await one(`SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE' AND merged_into IS NULL) active,
      COUNT(*) FILTER (WHERE status = 'ACTIVE' AND is_client AND merged_into IS NULL) clients,
      COUNT(*) FILTER (WHERE status <> 'ACTIVE') inactive FROM business_partner`);
  const fm = await one(`SELECT COUNT(DISTINCT partner_id) n FROM bp_fullmakt WHERE status = 'ACTIVE' AND valid_to BETWEEN current_date AND current_date + 60`);
  const dup = await one(`SELECT COUNT(*) n FROM (SELECT replace(i.identifier_value, ' ', '') v FROM bp_identifier i JOIN business_partner p ON p.id = i.partner_id
      WHERE i.identifier_type = 'ORG_NO' AND i.status = 'ACTIVE' AND p.status = 'ACTIVE' GROUP BY 1 HAVING COUNT(DISTINCT p.id) > 1) x`);
  return { ...r, fullmaktExpiring: fm!.n, duplicates: dup!.n };
}

/** Partners for a declaration box (f2, f8, f14): those holding a fitting role first. */
export async function lookup(box: string, q: string) {
  const need = R.BOX_ROLES[box] ?? [];
  const rows = await list({ q, status: 'ACTIVE' });
  return rows.map(r => ({ ...r, hasRole: !need.length || need.some(x => (r.roles as string[]).includes(x)) }))
    .sort((a, b) => Number(b.hasRole) - Number(a.hasRole) || a.legal_name.localeCompare(b.legal_name)).slice(0, 50);
}

/* ------------------------------ writing ------------------------------ */
async function touch(c: Db, id: string, req: Request) {
  await c.query('UPDATE business_partner SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [id, who(req)]);
}

/** Create a partner, or change its general data (version-checked: two people never overwrite each other). */
export async function saveGeneral(req: Request, b: any) {
  const data = {
    category: upper(b.category) ?? 'ORGANIZATION', legal_name: str(b.legal_name) ?? '', registration_country: upper(b.registration_country) ?? 'NO',
    language: upper(b.language) ?? 'NO', is_client: bool(b.is_client), notes: str(b.notes),
    default_incoterms: upper(b.default_incoterms), default_incoterms_place: str(b.default_incoterms_place),
    deposit_paid: bool(b.deposit_paid), deposit_amount: str(b.deposit_amount) ? Number(String(b.deposit_amount).replace(',', '.')) : null, deposit_date: date(b.deposit_date),
    ai_off: bool(b.ai_off)            // the client has refused AI processing (phase 2c)
  };
  throwFindings(R.checkPartner(data));
  if (!(await one('SELECT 1 FROM country WHERE code = $1', [data.registration_country])) && (await one('SELECT COUNT(*) n FROM country'))!.n > 0)
    fail(400, `${data.registration_country} er ikke en kjent landkode. Velg et land fra listen.`, 'COUNTRY');
  if (!b.id) {
    const p = (await one(`INSERT INTO business_partner (category, legal_name, search_name, registration_country, language, is_client, notes,
        default_incoterms, default_incoterms_place, deposit_paid, deposit_amount, deposit_date, created_by, updated_by, ai_off)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14) RETURNING *`,
      [data.category, data.legal_name, R.searchName(data.legal_name), data.registration_country, data.language, data.is_client, data.notes,
        data.default_incoterms, data.default_incoterms_place, data.deposit_paid, data.deposit_amount, data.deposit_date, who(req), data.ai_off]))!;
    await audit(req, { action: 'PARTNER_CREATED', objectType: 'PARTNER', objectId: p.id, after: data });
    return { partner: await get(p.id), warnings: [] };
  }
  const before = await requirePartner(b.id);
  if (b.version != null && Number(b.version) !== before.version) fail(409, 'Partneren er endret av en annen bruker. Last inn på nytt før du lagrer.', 'VERSION');
  if (before.merged_into) fail(409, 'Partneren er slått sammen med en annen og kan ikke endres.', 'MERGED');
  await query(`UPDATE business_partner SET category=$2, legal_name=$3, search_name=$4, registration_country=$5, language=$6, is_client=$7, notes=$8,
      default_incoterms=$9, default_incoterms_place=$10, deposit_paid=$11, deposit_amount=$12, deposit_date=$13, ai_off=$15, version = version + 1, updated_at = now(), updated_by = $14 WHERE id = $1`,
    [b.id, data.category, data.legal_name, R.searchName(data.legal_name), data.registration_country, data.language, data.is_client, data.notes,
      data.default_incoterms, data.default_incoterms_place, data.deposit_paid, data.deposit_amount, data.deposit_date, who(req), data.ai_off]);
  const pick = (o: any) => Object.fromEntries(Object.keys(data).map(k => [k, o[k] instanceof Date ? o[k].toISOString().slice(0, 10) : o[k] == null ? null : k === 'deposit_amount' ? Number(o[k]) : o[k]]));
  await audit(req, { action: 'PARTNER_CHANGED', objectType: 'PARTNER', objectId: b.id, before: pick(before), after: pick(data) });
  return { partner: await get(b.id), warnings: [] };
}

/** Add (no id) or change (id) one dated row. Errors refuse; warnings come back with the card. */
export async function saveChild(req: Request, partnerId: string, kind: Kind, b: any) {
  const K = KINDS[kind];
  const p = await requirePartner(partnerId);
  if (p.merged_into) fail(409, 'Partneren er slått sammen med en annen og kan ikke endres.', 'MERGED');
  const row = K.norm(b);
  const others = await query(`SELECT * FROM ${K.table} WHERE partner_id = $1`, [partnerId]);
  const before = b.id ? others.find(o => o.id === b.id) : null;
  if (b.id && !before) fail(404, 'Fant ikke raden.');
  if (before && before.status !== 'ACTIVE') fail(409, 'En avsluttet rad kan ikke endres. Legg inn en ny.', 'ENDED');
  const warnings = throwFindings(K.check({ ...row, id: b.id, status: 'ACTIVE' }, others));
  if (kind === 'identifiers' && row.identifier_type === 'ORG_NO') {
    const dup = await one(`SELECT p.partner_no, p.legal_name FROM bp_identifier i JOIN business_partner p ON p.id = i.partner_id WHERE i.identifier_type = 'ORG_NO'
        AND i.status = 'ACTIVE' AND replace(i.identifier_value, ' ', '') = $1 AND p.id <> $2 AND p.merged_into IS NULL LIMIT 1`, [row.identifier_value, partnerId]);
    if (dup) warnings.push({ lvl: 'warn', rule: 'ORG_NO_DUPLICATE', msg: `Organisasjonsnummeret er også registrert på ${dup.partner_no} ${dup.legal_name}. Vurder å slå partnerne sammen.` });
  }
  if (kind === 'credit') {
    const taken = await one(`SELECT p.partner_no FROM bp_credit_account c JOIN business_partner p ON p.id = c.partner_id WHERE c.account = $1 AND c.status = 'ACTIVE' AND c.id <> $2`,
      [row.account, b.id ?? '00000000-0000-0000-0000-000000000000']);
    if (taken) fail(409, `Konto ${row.account} er allerede registrert på ${taken.partner_no}.`, 'CREDIT_TAKEN');
  }
  await tx(async c => {
    // One primary per identifier type / one primary contact.
    if (row.is_primary && kind === 'identifiers') await c.query('UPDATE bp_identifier SET is_primary = false WHERE partner_id = $1 AND identifier_type = $2', [partnerId, row.identifier_type]);
    if (row.is_primary && kind === 'contacts') await c.query('UPDATE bp_contact SET is_primary = false WHERE partner_id = $1', [partnerId]);
    const cols = K.fields;
    if (before) await c.query(`UPDATE ${K.table} SET ${cols.map((f, i) => `${f} = $${i + 2}`).join(', ')}${kind === 'identifiers' ? ', check_status = NULL, checked_at = NULL' : ''} WHERE id = $1`,
      [b.id, ...cols.map(f => row[f])]);
    else await c.query(`INSERT INTO ${K.table} (partner_id, ${cols.join(', ')}${kind === 'identifiers' ? ', source' : ''}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}${kind === 'identifiers' ? ", 'MANUAL'" : ''})`,
      [partnerId, ...cols.map(f => row[f])]);
    await touch(c, partnerId, req);
    await audit(req, { action: before ? 'PARTNER_ROW_CHANGED' : 'PARTNER_ROW_ADDED', objectType: 'PARTNER', objectId: partnerId,
      before: before ? Object.fromEntries(cols.map(f => [f, before[f] instanceof Date ? before[f].toISOString().slice(0, 10) : before[f]])) : null, after: row, detail: { kind } }, c);
  });
  return { partner: await get(partnerId), warnings };
}

/** End a dated row (it stays as history). */
export async function endChild(req: Request, partnerId: string, kind: Kind, rowId: string, endDate?: string) {
  const K = KINDS[kind];
  await requirePartner(partnerId);
  const row = await one(`SELECT * FROM ${K.table} WHERE id = $1 AND partner_id = $2`, [rowId, partnerId]);
  if (!row) fail(404, 'Fant ikke raden.');
  const end = date(endDate) ?? today();
  await tx(async c => {
    await c.query(`UPDATE ${K.table} SET status = 'ENDED'${K.fields.includes('valid_to') ? ', valid_to = COALESCE(LEAST(valid_to, $2::date), $2::date)' : ''}${kind === 'contacts' || kind === 'identifiers' ? ', is_primary = false' : ''}${kind === 'addresses' ? ', is_standard = false' : ''} WHERE id = $1`,
      K.fields.includes('valid_to') ? [rowId, end] : [rowId]);
    await touch(c, partnerId, req);
    await audit(req, { action: 'PARTNER_ROW_ENDED', objectType: 'PARTNER', objectId: partnerId, detail: { kind, rowId, end } }, c);
  });
  return { partner: await get(partnerId), warnings: [] };
}

export async function saveRelationship(req: Request, partnerId: string, b: any) {
  await requirePartner(partnerId);
  const row = { source_partner_id: partnerId, target_partner_id: str(b.target_partner_id), relationship_type: upper(b.relationship_type), valid_from: date(b.valid_from), valid_to: date(b.valid_to), notes: str(b.notes) };
  throwFindings(R.checkRelationship(row));
  await requirePartner(row.target_partner_id!);
  await query(`INSERT INTO bp_relationship (source_partner_id, target_partner_id, relationship_type, valid_from, valid_to, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.source_partner_id, row.target_partner_id, row.relationship_type, row.valid_from, row.valid_to, row.notes]);
  await audit(req, { action: 'PARTNER_LINK_ADDED', objectType: 'PARTNER', objectId: partnerId, after: row });
  return { partner: await get(partnerId), warnings: [] };
}
export async function endRelationship(req: Request, partnerId: string, relId: string) {
  const r = await one('SELECT * FROM bp_relationship WHERE id = $1 AND (source_partner_id = $2 OR target_partner_id = $2)', [relId, partnerId]);
  if (!r) fail(404, 'Fant ikke koblingen.');
  await query("UPDATE bp_relationship SET status = 'ENDED', valid_to = COALESCE(valid_to, current_date) WHERE id = $1", [relId]);
  await audit(req, { action: 'PARTNER_LINK_ENDED', objectType: 'PARTNER', objectId: partnerId, detail: { relId } });
  return { partner: await get(partnerId), warnings: [] };
}

export async function saveFullmakt(req: Request, partnerId: string, b: any) {
  await requirePartner(partnerId);
  const row = { partner_id: partnerId, representative_id: str(b.representative_id), representation: upper(b.representation) ?? 'DIRECT',
    scope: upper(b.scope) ?? 'IMPORT_EXPORT', valid_from: date(b.valid_from), valid_to: date(b.valid_to), document_ref: str(b.document_ref) };
  throwFindings(R.checkFullmakt(row));
  if (!['IMPORT', 'EXPORT', 'IMPORT_EXPORT'].includes(row.scope)) fail(400, 'Ukjent omfang for fullmakten.');
  await requirePartner(row.representative_id!);
  await query(`INSERT INTO bp_fullmakt (partner_id, representative_id, representation, scope, valid_from, valid_to, document_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.partner_id, row.representative_id, row.representation, row.scope, row.valid_from, row.valid_to, row.document_ref]);
  await audit(req, { action: 'FULLMAKT_ADDED', objectType: 'PARTNER', objectId: partnerId, after: row });
  return { partner: await get(partnerId), warnings: [] };
}
export async function revokeFullmakt(req: Request, partnerId: string, fmId: string) {
  const f = await one("SELECT * FROM bp_fullmakt WHERE id = $1 AND partner_id = $2 AND status = 'ACTIVE'", [fmId, partnerId]);
  if (!f) fail(404, 'Fant ikke en aktiv fullmakt.');
  await query("UPDATE bp_fullmakt SET status = 'REVOKED', valid_to = LEAST(COALESCE(valid_to, current_date), current_date) WHERE id = $1", [fmId]);
  await audit(req, { action: 'FULLMAKT_REVOKED', objectType: 'PARTNER', objectId: partnerId, detail: { fmId } });
  return { partner: await get(partnerId), warnings: [] };
}

/** Is there a valid authorisation from the party to the representative on the date? */
export async function fullmaktFor(partyId: string, repId: string, d = today()) {
  const rows = await query('SELECT * FROM bp_fullmakt WHERE partner_id = $1 AND representative_id = $2 ORDER BY valid_from DESC', [partyId, repId]);
  const valid = rows.find(r => R.inForce(r, d));
  if (valid) return { valid: true, scope: valid.scope, validTo: valid.valid_to };
  const last = rows.find(r => r.status === 'ACTIVE');
  return last ? { valid: false, expiredTo: last.valid_to } : null;
}

export async function setStatus(req: Request, id: string, status: 'ACTIVE' | 'INACTIVE') {
  const p = await requirePartner(id);
  if (p.merged_into && status === 'ACTIVE') fail(409, 'En sammenslått partner kan ikke aktiveres igjen.', 'MERGED');
  await query('UPDATE business_partner SET status = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [id, status, who(req)]);
  await audit(req, { action: status === 'ACTIVE' ? 'PARTNER_REACTIVATED' : 'PARTNER_DEACTIVATED', objectType: 'PARTNER', objectId: id, before: { status: p.status }, after: { status } });
  return { partner: await get(id), warnings: [] };
}

/**
 * Merge source into target: rows the target lacks move over, everything that points to the source
 * (products, RT permits, links, authorisations, credit accounts, prices) points to the target, and the
 * source is kept as an inactive record that says where it went.
 */
export async function merge(req: Request, sourceId: string, targetId: string) {
  if (sourceId === targetId) fail(400, 'Velg to forskjellige partnere.');
  const src = await requirePartner(sourceId), tgt = await requirePartner(targetId);
  if (src.merged_into) fail(409, `${src.partner_no} er allerede slått sammen.`, 'MERGED');
  if (tgt.status !== 'ACTIVE' || tgt.merged_into) fail(409, 'Partneren som beholdes, må være aktiv.', 'TARGET_INACTIVE');
  const moved: Record<string, number> = {};
  const run = async (c: pg.PoolClient, key: string, sql: string, p: unknown[]) => { moved[key] = (moved[key] ?? 0) + ((await c.query(sql, p)).rowCount ?? 0); };
  await tx(async c => {
    await run(c, 'identifiers', `UPDATE bp_identifier s SET partner_id = $2, is_primary = false WHERE s.partner_id = $1 AND NOT EXISTS
        (SELECT 1 FROM bp_identifier t WHERE t.partner_id = $2 AND t.identifier_type = s.identifier_type AND replace(t.identifier_value, ' ', '') = replace(s.identifier_value, ' ', ''))`, [sourceId, targetId]);
    await run(c, 'roles', `UPDATE bp_role s SET partner_id = $2 WHERE s.partner_id = $1 AND NOT EXISTS
        (SELECT 1 FROM bp_role t WHERE t.partner_id = $2 AND t.role_code = s.role_code AND t.status = 'ACTIVE')`, [sourceId, targetId]);
    await run(c, 'addresses', 'UPDATE bp_address SET partner_id = $2, is_standard = false WHERE partner_id = $1', [sourceId, targetId]);
    await run(c, 'contacts', 'UPDATE bp_contact SET partner_id = $2, is_primary = false WHERE partner_id = $1', [sourceId, targetId]);
    await run(c, 'credit', 'UPDATE bp_credit_account SET partner_id = $2 WHERE partner_id = $1', [sourceId, targetId]);
    await run(c, 'links', 'UPDATE bp_relationship SET source_partner_id = $2 WHERE source_partner_id = $1 AND target_partner_id <> $2', [sourceId, targetId]);
    await run(c, 'links', 'UPDATE bp_relationship SET target_partner_id = $2 WHERE target_partner_id = $1 AND source_partner_id <> $2', [sourceId, targetId]);
    await run(c, 'fullmakt', 'UPDATE bp_fullmakt SET partner_id = $2 WHERE partner_id = $1 AND representative_id <> $2', [sourceId, targetId]);
    await run(c, 'fullmakt', 'UPDATE bp_fullmakt SET representative_id = $2 WHERE representative_id = $1 AND partner_id <> $2', [sourceId, targetId]);
    await run(c, 'prices', `UPDATE bp_price s SET partner_id = $2 WHERE s.partner_id = $1 AND NOT EXISTS
        (SELECT 1 FROM bp_price t WHERE t.partner_id = $2 AND t.item_code = s.item_code AND t.valid_from = s.valid_from)`, [sourceId, targetId]);
    // Registers added in later migrations (products, RT permits) point to the target too.
    for (const [key, table, col] of [['products', 'product', 'owner_id'], ['products', 'product', 'supplier_id'], ['rtPermits', 'rt_permit', 'holder_id']] as const)
      if ((await c.query('SELECT to_regclass($1) t', [table])).rows[0].t) await run(c, key, `UPDATE ${table} SET ${col} = $2 WHERE ${col} = $1`, [sourceId, targetId]);
    // Article numbers that belonged to the source belong to the target (unless the target already has the same one).
    if ((await c.query("SELECT to_regclass('product_identifier') t")).rows[0].t)
      await run(c, 'articleNumbers', `UPDATE product_identifier s SET partner_id = $2 WHERE s.partner_id = $1 AND NOT EXISTS
          (SELECT 1 FROM product_identifier t WHERE t.partner_id = $2 AND t.type = s.type AND t.norm = s.norm)`, [sourceId, targetId]);
    await c.query("UPDATE business_partner SET status = 'INACTIVE', merged_into = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1", [sourceId, targetId, who(req)]);
    await touch(c, targetId, req);
    await audit(req, { action: 'PARTNER_MERGED', objectType: 'PARTNER', objectId: sourceId, detail: { into: tgt.partner_no, moved } }, c);
    await audit(req, { action: 'PARTNER_MERGED', objectType: 'PARTNER', objectId: targetId, detail: { from: src.partner_no, moved } }, c);
  });
  return { partner: await get(targetId), moved, warnings: [] };
}

/* ------------------------------ prices (locked per client) ------------------------------ */
export const priceItems = () => query('SELECT * FROM price_item WHERE active ORDER BY sort');

/**
 * Lock a client's price for an item from a date. A locked price is never edited: the new price starts
 * on a later date (today or after), and the previous one ends the day before.
 */
export async function lockPrice(req: Request, partnerId: string, b: any) {
  await requirePartner(partnerId);
  const item = await one('SELECT * FROM price_item WHERE code = $1 AND active', [str(b.item_code)]);
  if (!item) fail(400, 'Velg en tjeneste fra prislisten.');
  const price = Number(String(b.price ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(price) || price < 0) fail(400, 'Prisen må være et tall som er null eller større.');
  const from = date(b.valid_from) ?? today();
  if (from < today()) fail(400, 'En låst pris kan ikke tilbakedateres. Velg i dag eller en senere dato.', 'PRICE_BACKDATED');
  const freeLines = str(b.free_lines) ? Math.max(0, Math.round(Number(b.free_lines))) : null;
  await tx(async c => {
    const cur = (await c.query('SELECT * FROM bp_price WHERE partner_id = $1 AND item_code = $2 ORDER BY valid_from DESC LIMIT 1', [partnerId, item!.code])).rows[0];
    if (cur && String(cur.valid_from) >= from) fail(409, `Prisen er låst fra ${cur.valid_from}. En ny pris må gjelde fra en senere dato.`, 'PRICE_LOCKED');
    if (cur) await c.query("UPDATE bp_price SET valid_to = $2::date - 1 WHERE id = $1 AND (valid_to IS NULL OR valid_to >= $2::date)", [cur.id, from]);
    await c.query('INSERT INTO bp_price (partner_id, item_code, price, free_lines, valid_from, locked_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [partnerId, item!.code, price, freeLines, from, who(req), str(b.note)]);
    await touch(c, partnerId, req);
    await audit(req, { action: 'PRICE_LOCKED', objectType: 'PARTNER', objectId: partnerId, before: cur ? { [item!.code]: Number(cur.price) } : null, after: { [item!.code]: price }, detail: { from, freeLines } }, c);
  });
  return { partner: await get(partnerId), warnings: [] };
}

/** The client's price for an item on a date, else the list price (used by invoicing in phase 4). */
export async function priceFor(partnerId: string, itemCode: string, d = today()) {
  const own = await one(`SELECT price, free_lines FROM bp_price WHERE partner_id = $1 AND item_code = $2 AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)`, [partnerId, itemCode, d]);
  if (own) return { price: own.price, freeLines: own.free_lines, source: 'AGREEMENT' };
  const list = await one('SELECT price, free_lines FROM price_item WHERE code = $1', [itemCode]);
  return list ? { price: list.price, freeLines: list.free_lines, source: 'LIST' } : null;
}

export async function saveInvoicing(req: Request, partnerId: string, b: any) {
  await requirePartner(partnerId);
  const row = { consolidation: upper(b.consolidation) ?? 'PER_DECLARATION', due_days: Math.max(0, Math.round(Number(b.due_days ?? 14))) || 14,
    invoice_email: str(b.invoice_email)?.toLowerCase() ?? null, ehf: bool(b.ehf), notes: str(b.notes) };
  if (!['PER_DECLARATION', 'MONTHLY'].includes(row.consolidation)) fail(400, 'Velg faktura per deklarasjon eller per måned.');
  if (row.invoice_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.invoice_email)) fail(400, 'Fakturaadressen (e-post) er ikke gyldig.');
  const before = await one('SELECT consolidation, due_days, invoice_email, ehf, notes FROM bp_invoicing WHERE partner_id = $1', [partnerId]);
  await query(`INSERT INTO bp_invoicing (partner_id, consolidation, due_days, invoice_email, ehf, notes) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (partner_id) DO UPDATE SET consolidation = EXCLUDED.consolidation, due_days = EXCLUDED.due_days, invoice_email = EXCLUDED.invoice_email, ehf = EXCLUDED.ehf, notes = EXCLUDED.notes`,
    [partnerId, row.consolidation, row.due_days, row.invoice_email, row.ehf, row.notes]);
  await audit(req, { action: 'INVOICING_CHANGED', objectType: 'PARTNER', objectId: partnerId, before, after: row });
  return { partner: await get(partnerId), warnings: [] };
}

/* ------------------------------ Brønnøysund ------------------------------ */
/** Search Enhetsregisteret; each hit says whether it is already a partner. */
export async function brregSearch(q: string) {
  const units = await brreg.search(q);
  const known = units.length ? await query(`SELECT replace(i.identifier_value, ' ', '') org, p.id, p.partner_no FROM bp_identifier i JOIN business_partner p ON p.id = i.partner_id
      WHERE i.identifier_type = 'ORG_NO' AND i.status = 'ACTIVE' AND p.merged_into IS NULL AND replace(i.identifier_value, ' ', '') = ANY($1)`, [units.map(u => u.orgNo)]) : [];
  return units.map(u => ({ ...u, partner: known.find(k => k.org === u.orgNo) ?? null }));
}

async function storeRegistry(c: Db, partnerId: string, u: brreg.BrregUnit, roles: unknown) {
  await c.query(`INSERT INTO bp_registry (partner_id, org_no, vat_registered, bankrupt, winding_up, forced_dissolution, deleted, data, roles, fetched_at, fetch_error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), NULL) ON CONFLICT (partner_id) DO UPDATE SET org_no = EXCLUDED.org_no, vat_registered = EXCLUDED.vat_registered,
      bankrupt = EXCLUDED.bankrupt, winding_up = EXCLUDED.winding_up, forced_dissolution = EXCLUDED.forced_dissolution, deleted = EXCLUDED.deleted,
      data = EXCLUDED.data, roles = EXCLUDED.roles, fetched_at = now(), fetch_error = NULL`,
    [partnerId, u.orgNo, u.vatRegistered, u.bankrupt, u.windingUp, u.forcedDissolution, u.deleted, JSON.stringify(u), roles ? JSON.stringify(roles) : null]);
}
const brregAddress = (a: brreg.BrregAddress | null) => a && { street: a.lines.join(', ') || null, postal_code: a.postalCode, city: a.city, country_code: (a.countryCode || 'NO').toUpperCase() };

/** Create a partner from Enhetsregisteret: name, org. no., EORI, VAT no., addresses, contact, live status. */
export async function importFromBrreg(req: Request, b: any) {
  const orgNo = R.digits(b.orgNo);
  const exists = await one(`SELECT p.partner_no FROM bp_identifier i JOIN business_partner p ON p.id = i.partner_id WHERE i.identifier_type = 'ORG_NO'
      AND i.status = 'ACTIVE' AND replace(i.identifier_value, ' ', '') = $1 AND p.merged_into IS NULL LIMIT 1`, [orgNo]);
  if (exists) fail(409, `Organisasjonsnummeret er allerede registrert på ${exists.partner_no}.`, 'EXISTS');
  const u = await brreg.getUnit(orgNo);
  if (!u) fail(404, 'Organisasjonsnummeret finnes ikke i Enhetsregisteret.');
  const roles = await brreg.getRoles(orgNo).catch(() => null);
  const roleCodes: string[] = Array.isArray(b.roles) ? b.roles.map((r: string) => String(r).toUpperCase()).filter((r: string) => R.ROLES[r]) : [];
  const id = await tx(async c => {
    const p = (await c.query(`INSERT INTO business_partner (category, legal_name, search_name, registration_country, is_client, source, created_by, updated_by)
        VALUES ('ORGANIZATION', $1, $2, 'NO', $3, 'BRREG', $4, $4) RETURNING id`, [u!.name, R.searchName(u!.name), bool(b.is_client), who(req)])).rows[0];
    const ids: [string, string, boolean][] = [['ORG_NO', orgNo, true], ['EORI', 'NO' + orgNo, true]];
    if (u!.vatRegistered) ids.push(['VAT_NO', `NO${orgNo}MVA`, true]);
    for (const [t, v, prim] of ids)
      await c.query(`INSERT INTO bp_identifier (partner_id, identifier_type, identifier_value, issuing_country, is_primary, source) VALUES ($1,$2,$3,'NO',$4,'BRREG')`, [p.id, t, v, prim]);
    const reg = brregAddress(u!.businessAddress), post = brregAddress(u!.postalAddress);
    if (reg) await c.query(`INSERT INTO bp_address (partner_id, address_type, street, postal_code, city, country_code, is_standard) VALUES ($1,'REGISTERED',$2,$3,$4,$5,true)`, [p.id, reg.street, reg.postal_code, reg.city, reg.country_code]);
    if (post) await c.query(`INSERT INTO bp_address (partner_id, address_type, street, postal_code, city, country_code, is_standard) VALUES ($1,'POSTAL',$2,$3,$4,$5,false)`, [p.id, post.street, post.postal_code, post.city, post.country_code]);
    if (u!.email || u!.phone) await c.query(`INSERT INTO bp_contact (partner_id, contact_type, contact_name, email, telephone, is_primary) VALUES ($1,'GENERAL',$2,$3,$4,true)`,
      [p.id, (roles?.dailyManager ?? [])[0] ?? null, u!.email?.toLowerCase() ?? null, u!.phone]);
    for (const r of roleCodes) await c.query('INSERT INTO bp_role (partner_id, role_code) VALUES ($1, $2)', [p.id, r]);
    await storeRegistry(c, p.id, u!, roles);
    await audit(req, { action: 'PARTNER_CREATED', objectType: 'PARTNER', objectId: p.id, after: { legal_name: u!.name, org_no: orgNo, roles: roleCodes }, detail: { source: 'BRREG' } }, c);
    return p.id as string;
  });
  const warnings: R.Finding[] = [];
  if (u!.deleted) warnings.push({ lvl: 'warn', rule: 'BRREG_DELETED', msg: 'Enheten er slettet fra Enhetsregisteret.' });
  if (u!.bankrupt || u!.windingUp || u!.forcedDissolution) warnings.push({ lvl: 'warn', rule: 'BRREG_STATUS', msg: 'Enheten er konkurs eller under avvikling ifølge Brønnøysund.' });
  return { partner: await get(id), warnings };
}

/** Fetch the live record again and show what differs from the card (name, registered address). */
export async function refreshRegistry(req: Request, id: string) {
  const p = await get(id);
  if (!p.orgNo) fail(400, 'Partneren har ikke organisasjonsnummer.');
  let u: brreg.BrregUnit | null;
  try { u = await brreg.getUnit(p.orgNo!); }
  catch (e) { await query('UPDATE bp_registry SET fetch_error = $2 WHERE partner_id = $1', [id, (e as Error).message]); throw e; }
  if (!u) fail(404, 'Organisasjonsnummeret finnes ikke i Enhetsregisteret.');
  const roles = await brreg.getRoles(p.orgNo!).catch(() => null);
  await storeRegistry(pool, id, u!, roles);
  await audit(req, { action: 'BRREG_CHECKED', objectType: 'PARTNER', objectId: id, detail: { vat: u!.vatRegistered, bankrupt: u!.bankrupt, deleted: u!.deleted } });
  const reg = brregAddress(u!.businessAddress);
  const cur = p.addresses.find((a: any) => a.address_type === 'REGISTERED' && a.status === 'ACTIVE');
  const diff = {
    name: u!.name !== p.legal_name ? { card: p.legal_name, registry: u!.name } : null,
    address: reg && (!cur || [cur.street, cur.postal_code, cur.city].join('|') !== [reg.street, reg.postal_code, reg.city].join('|'))
      ? { card: formatAddress(cur), registry: formatAddress(reg) } : null
  };
  return { partner: await get(id), diff, warnings: [] };
}

/** Take the name and/or registered address from Brønnøysund onto the card. */
export async function applyRegistry(req: Request, id: string, b: { name?: boolean; address?: boolean }) {
  const reg = await one('SELECT data FROM bp_registry WHERE partner_id = $1', [id]);
  if (!reg) fail(400, 'Hent data fra Brønnøysund først.');
  const u = reg!.data as brreg.BrregUnit;
  await tx(async c => {
    if (b.name) await c.query('UPDATE business_partner SET legal_name = $2, search_name = $3 WHERE id = $1', [id, u.name, R.searchName(u.name)]);
    const a = brregAddress(u.businessAddress);
    if (b.address && a) {
      const std = (await c.query("SELECT 1 FROM bp_address WHERE partner_id = $1 AND address_type = 'REGISTERED' AND is_standard AND status = 'ACTIVE'", [id])).rowCount;
      await c.query("UPDATE bp_address SET status = 'ENDED', valid_to = current_date - 1, is_standard = false WHERE partner_id = $1 AND address_type = 'REGISTERED' AND status = 'ACTIVE'", [id]);
      await c.query(`INSERT INTO bp_address (partner_id, address_type, street, postal_code, city, country_code, is_standard, valid_from) VALUES ($1,'REGISTERED',$2,$3,$4,$5,$6,current_date)`,
        [id, a.street, a.postal_code, a.city, a.country_code, !!std]);
    }
    await touch(c, id, req);
    await audit(req, { action: 'BRREG_APPLIED', objectType: 'PARTNER', objectId: id, detail: b }, c);
  });
  return { partner: await get(id), warnings: [] };
}

/* ------------------------------ EORI ------------------------------ */
export async function checkEori(req: Request, partnerId: string, identifierId: string) {
  const i = await one("SELECT * FROM bp_identifier WHERE id = $1 AND partner_id = $2 AND identifier_type = 'EORI'", [identifierId, partnerId]);
  if (!i) fail(404, 'Fant ikke EORI-nummeret.');
  const ap = eori.applicability(i!.identifier_value);
  if (!ap.ok) {
    await query("UPDATE bp_identifier SET check_status = 'NOT_APPLICABLE', check_error = $2, checked_at = now(), check_name = NULL, check_address = NULL WHERE id = $1", [i!.id, ap.reason]);
    return { partner: await get(partnerId), warnings: [{ lvl: 'warn', rule: 'EORI_NOT_APPLICABLE', msg: ap.reason! }] };
  }
  let res: eori.EoriResult;
  try { [res] = await eori.validate([i!.identifier_value]); }
  catch (e) { await query('UPDATE bp_identifier SET check_error = $2, checked_at = now() WHERE id = $1', [i!.id, (e as Error).message]); throw e; }
  await query('UPDATE bp_identifier SET check_status = $2, check_name = $3, check_address = $4, checked_at = now(), check_error = NULL WHERE id = $1',
    [i!.id, res.valid ? 'VALID' : 'INVALID', res.name, res.address]);
  await audit(req, { action: 'EORI_CHECKED', objectType: 'PARTNER', objectId: partnerId, detail: { eori: res.eori, valid: res.valid } });
  return { partner: await get(partnerId), warnings: res.valid ? [] : [{ lvl: 'warn' as const, rule: 'EORI_INVALID', msg: `EORI ${res.eori} er ikke gyldig ifølge EUs EORI-tjeneste.` }] };
}

export const META = { roles: R.ROLES, addressTypes: R.ADDRESS_TYPES, identifierTypes: R.IDENTIFIER_TYPES, contactTypes: R.CONTACT_TYPES,
  relationshipTypes: R.RELATIONSHIP_TYPES, categories: R.CATEGORIES };
