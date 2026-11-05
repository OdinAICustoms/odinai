import crypto from 'node:crypto';
import type { Request } from 'express';
import { one, query, tx, pool, type Db } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import { check, changedKeys, get, reference, IMMUTABLE, type Kind } from './rules.js';

/**
 * Digitoll (phase 3b): transport, master and house consignments, the simulator, and what needs a person.
 * Carried over from ODIN LINK src/digitoll (repo.js, builder.js, service.js), road first.
 *
 *  * The simulator answers as Tolletaten's movement API does: an MRN for a new message, the same MRN for an
 *    amendment, validation errors as a rejection, missing documentation as INCOMPLETE. Nothing leaves the PC.
 *  * Never double filing: an amendment goes out with the same MRN; key fields are locked after the MRN.
 */
const TABLE: Record<Kind, string> = { TRANSPORT: 'digitoll_transport', MASTER: 'digitoll_master', HOUSE: 'digitoll_house' };
const LABEL: Record<Kind, string> = { TRANSPORT: 'Transporten', MASTER: 'Hovedforsendelsen', HOUSE: 'Forsendelsen' };
export const KINDS: Record<string, Kind> = { transports: 'TRANSPORT', masters: 'MASTER', houses: 'HOUSE' };
const isUuid = (v: unknown) => /^[0-9a-f-]{36}$/i.test(String(v ?? ''));
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const MODE_CODE: Record<string, string> = { ROAD: '3', RAIL: '2', AIR: '4', SEA: '1' };
const IDENT_TYPE: Record<string, string> = { ROAD: '30', RAIL: '21', AIR: '41', SEA: '10' };
export const ADAPTER = 'simulator';

/* ------------------------------ parties from the register ------------------------------ */
async function party(id: string | null, db: Db = pool) {
  if (!id) return null;
  const b = await one(`SELECT b.legal_name, b.category, b.registration_country,
      (SELECT identifier_value FROM bp_identifier i WHERE i.partner_id = b.id AND i.identifier_type IN ('EORI', 'ORG_NO') AND i.status = 'ACTIVE' ORDER BY (i.identifier_type = 'EORI') DESC LIMIT 1) ident,
      a.street, a.postal_code, a.city, a.country_code
      FROM business_partner b LEFT JOIN LATERAL (SELECT * FROM bp_address x WHERE x.partner_id = b.id AND x.status = 'ACTIVE' ORDER BY x.is_standard DESC LIMIT 1) a ON true
      WHERE b.id = $1`, [id], db);
  if (!b) return null;
  const address = Object.fromEntries(Object.entries({ streetLine: b.street, postcode: b.postal_code, city: b.city, country: b.country_code ?? b.registration_country }).filter(([, v]) => v));
  return { name: String(b.legal_name).slice(0, 70), ...(b.ident ? { identificationNumber: String(b.ident).replace(/\s/g, '') } : {}), typeOfPerson: b.category === 'PERSON' ? 1 : 2, address };
}

/* ------------------------------ templates ------------------------------ */
export function template(kind: Kind, mode = 'ROAD') {
  if (kind === 'TRANSPORT') return {
    documentIssueDate: nowIso(),
    activeBorderTransportMeans: { modeOfTransportCode: MODE_CODE[mode], typeOfIdentification: IDENT_TYPE[mode], identificationNumber: '', countryCode: '', operator: { name: '', communication: [{ identifier: '', type: 'TE' }] } },
    carrier: { name: '', identificationNumber: '', address: { city: '', country: '' } },
    customsOfficeOfFirstEntry: { referenceNumber: '' }, scheduledDateAndTimeOfArrival: '', estimatedDateAndTimeOfArrival: '', consignmentMasterLevel: []
  };
  if (kind === 'MASTER') return {
    documentIssueDate: nowIso(),
    consignmentMasterLevel: { containerIndicator: 0, grossMass: null, transportDocumentMasterLevel: { documentNumber: '', type: 'N730' },
      consignor: { name: '', typeOfPerson: 2, address: {} }, consignee: { name: '', typeOfPerson: 2, address: {} } }
  };
  return {
    documentIssueDate: nowIso(),
    consignmentHouseLevel: { containerIndicator: 0, totalGrossMass: null, numberOfPackages: null, goodsDescription: '',
      transportDocumentHouseLevel: { documentNumber: '', type: 'N730' }, importProcedure: { importProcedure: 'IMMEDIATE_RELEASE_IMPORT', hasOutgoingProcedure: false },
      previousDocuments: [], consignor: { name: '', typeOfPerson: 2, address: {} }, consignee: { name: '', typeOfPerson: 2, address: {} } }
  };
}

/** The key columns kept next to the JSON body, for lists and links. */
function columns(kind: Kind, data: any) {
  if (kind === 'TRANSPORT') { const t = data.scheduledDateAndTimeOfArrival; return { means_id: str(get(data, 'activeBorderTransportMeans.identificationNumber')), scheduled_arrival: t && !Number.isNaN(Date.parse(t)) ? t : null }; }
  if (kind === 'MASTER') return { doc_number: str(get(data, 'consignmentMasterLevel.transportDocumentMasterLevel.documentNumber')), doc_type: str(get(data, 'consignmentMasterLevel.transportDocumentMasterLevel.type')) };
  return { doc_number: str(get(data, 'consignmentHouseLevel.transportDocumentHouseLevel.documentNumber')), doc_type: str(get(data, 'consignmentHouseLevel.transportDocumentHouseLevel.type')),
    import_procedure: str(get(data, 'consignmentHouseLevel.importProcedure.importProcedure')) };
}

async function requireObj(kind: Kind, id: string, db: Db = pool) {
  if (!isUuid(id)) fail(404, 'Fant ikke Digitoll-meldingen.');
  const r = await one(`SELECT * FROM ${TABLE[kind]} WHERE id = $1`, [id], db);
  if (!r) fail(404, 'Fant ikke Digitoll-meldingen.');
  return r!;
}
const children = async (kind: Kind, id: string, db: Db = pool) => kind === 'TRANSPORT'
  ? (await one<{ n: number }>(`SELECT (SELECT COUNT(*) FROM digitoll_master WHERE transport_id = $1 AND status <> 'CANCELLED') + (SELECT COUNT(*) FROM digitoll_house WHERE transport_id = $1 AND status <> 'CANCELLED') n`, [id], db))!.n
  : kind === 'MASTER' ? (await one<{ n: number }>(`SELECT COUNT(*) n FROM digitoll_house WHERE master_id = $1 AND status <> 'CANCELLED'`, [id], db))!.n : 0;
const log = (c: Db, kind: Kind, id: string, direction: 'OUT' | 'IN', operation: string, mrn: string | null, payload: unknown, userId: string | null) =>
  c.query('INSERT INTO digitoll_message (object_type, object_id, direction, operation, adapter, mrn, payload, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [kind, id, direction, operation, ADAPTER, mrn, JSON.stringify(payload), userId]);

/* ------------------------------ the declaration's ID (CUDE) ------------------------------ */
/** "931481274-05112026-12-1" → the CUDE reference Tolletaten wants on the house consignment. */
export function cudeOf(tvinnId: string | null) {
  const m = String(tvinnId ?? '').match(/^(\d{9})-(\d{2})(\d{2})(\d{4})-(\d+)-\d+$/);
  return m ? { typeOfReference: 'CUDE', declarantNumber: m[1], declarationDate: `${m[4]}-${m[3]}-${m[2]}`, sequenceNumber: m[5] } : null;
}
/** Once the linked declaration has been sent, its CUDE is put on the house (never twice, never replacing one typed by hand). */
async function syncCude(h: any, db: Db = pool) {
  if (!h.declaration_id) return h;
  const v = await one(`SELECT tvinn_id FROM declaration_version WHERE declaration_id = $1 AND tvinn_id IS NOT NULL ORDER BY version_no DESC LIMIT 1`, [h.declaration_id], db);
  const cude = cudeOf(v?.tvinn_id ?? null);
  const docs: any[] = h.data?.consignmentHouseLevel?.previousDocuments ?? [];
  if (!cude || docs.some(d => d.typeOfReference === 'CUDE')) return h;
  const data = { ...h.data, consignmentHouseLevel: { ...h.data.consignmentHouseLevel, previousDocuments: [...docs, cude] } };
  await db.query(`UPDATE digitoll_house SET data = $2, pending_change = (mrn IS NOT NULL), updated_at = now() WHERE id = $1`, [h.id, JSON.stringify(data)]);
  return { ...h, data, pending_change: !!h.mrn };
}

/* ------------------------------ reading ------------------------------ */
export async function card(kind: Kind, id: string) {
  let r = await requireObj(kind, id);
  if (kind === 'HOUSE') r = await syncCude(r);
  const res = check(kind, r.mode, r.data, await children(kind, id));
  const links = kind === 'TRANSPORT' ? {
    masters: await query(`SELECT id, doc_number, status, mrn FROM digitoll_master WHERE transport_id = $1 ORDER BY created_at`, [id]),
    houses: await query(`SELECT id, doc_number, status, mrn FROM digitoll_house WHERE transport_id = $1 ORDER BY created_at`, [id])
  } : kind === 'MASTER' ? {
    transport: r.transport_id ? await one('SELECT id, means_id, status, mrn FROM digitoll_transport WHERE id = $1', [r.transport_id]) : null,
    houses: await query(`SELECT id, doc_number, status, mrn FROM digitoll_house WHERE master_id = $1 ORDER BY created_at`, [id])
  } : {
    master: r.master_id ? await one('SELECT id, doc_number, status, mrn FROM digitoll_master WHERE id = $1', [r.master_id]) : null,
    transport: r.transport_id ? await one('SELECT id, means_id, status, mrn FROM digitoll_transport WHERE id = $1', [r.transport_id]) : null,
    declaration: r.declaration_id ? await one('SELECT id, decl_no, status FROM declaration WHERE id = $1', [r.declaration_id]) : null,
    client: r.client_id ? await one('SELECT id, legal_name FROM business_partner WHERE id = $1', [r.client_id]) : null
  };
  return { kind, ...r, links, check: res, locked: r.mrn ? IMMUTABLE[kind] : [],
    messages: await query(`SELECT m.id, m.direction, m.operation, m.mrn, m.payload, m.created_at, u.name user_name FROM digitoll_message m LEFT JOIN users u ON u.id = m.created_by
      WHERE m.object_type = $1 AND m.object_id = $2 ORDER BY m.id DESC LIMIT 50`, [kind, id]) };
}

/** Everything, newest first, with what needs a person (ODIN LINK «Krever handling»). */
export async function overview() {
  const rows = async (kind: Kind, extra: string) => query(`SELECT '${kind}' kind, x.id, x.status, x.mrn, x.pending_change, x.updated_at, x.created_at, ${extra} FROM ${TABLE[kind]} x ORDER BY x.updated_at DESC LIMIT 300`);
  const transports = await rows('TRANSPORT', 'x.means_id label, x.scheduled_arrival, x.arrival_registered_at');
  const masters = await rows('MASTER', 'x.doc_number label, x.transport_id');
  const houses = await rows('HOUSE', `x.doc_number label, x.master_id, x.transport_id, x.declaration_id, x.import_procedure,
    (SELECT decl_no FROM declaration d WHERE d.id = x.declaration_id) decl_no, (SELECT legal_name FROM business_partner b WHERE b.id = x.client_id) client_name`);
  const attention: { kind: Kind; id: string; label: string | null; reason: string }[] = [];
  const now = Date.now();
  for (const r of [...transports, ...masters, ...houses]) {
    if (r.status === 'REJECTED') attention.push({ kind: r.kind, id: r.id, label: r.label, reason: 'Avvist av Tolletaten — rett feilene og send på nytt.' });
    if (r.status === 'INCOMPLETE') attention.push({ kind: r.kind, id: r.id, label: r.label, reason: 'Ufullstendig — må kompletteres senest ved grensepassering.' });
    if (r.pending_change && r.status !== 'CANCELLED') attention.push({ kind: r.kind, id: r.id, label: r.label, reason: 'Endret etter innsending — send endringen.' });
  }
  for (const t of transports) if (t.status === 'ACCEPTED' && t.scheduled_arrival && !t.arrival_registered_at && now - Date.parse(t.scheduled_arrival) > 48 * 3600e3)
    attention.push({ kind: 'TRANSPORT', id: t.id, label: t.label, reason: 'Ingen ankomst registrert 48 timer etter planlagt ankomst. Tolletaten kansellerer etter 72 timer.' });
  for (const h of houses) if (['ACCEPTED', 'INCOMPLETE'].includes(h.status) && !h.master_id && !h.transport_id && now - Date.parse(h.created_at) > 25 * 86400e3)
    attention.push({ kind: 'HOUSE', id: h.id, label: h.label, reason: 'Ikke koblet til hovedforsendelse eller transport etter 25 dager. Tolletaten kansellerer etter 30 dager.' });
  return { transports, masters, houses, attention, codes: { importProcedures: reference().codes.ImportProcedure, outgoingProcedures: reference().codes.OutgoingProcedure } };
}

/* ------------------------------ writing ------------------------------ */
export async function create(req: Request, kind: Kind, b: any = {}) {
  const data = b.data && typeof b.data === 'object' ? b.data : template(kind, 'ROAD');
  const id = await tx(async c => {
    const cols = { ...columns(kind, data), ...(kind === 'HOUSE' ? { declaration_id: b.declaration_id ?? null, client_id: b.client_id ?? null } : {}) };
    const keys = Object.keys(cols);
    const r = (await c.query(`INSERT INTO ${TABLE[kind]} (data, created_by, updated_by${keys.map(k => ', ' + k).join('')}) VALUES ($1, $2, $2${keys.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`,
      [JSON.stringify(data), req.user!.id, ...keys.map(k => (cols as any)[k])])).rows[0];
    await audit(req, { action: 'DIGITOLL_CREATED', objectType: 'DIGITOLL', objectId: r.id, detail: { kind, from: b.declaration_id ? 'DECLARATION' : 'MANUAL' } }, c);
    return r.id as string;
  });
  return card(kind, id);
}

/** A house consignment from an import declaration: parties, packages, gross mass and goods description (only pre-filled). */
export async function fromDeclaration(req: Request, declId: string) {
  const d = await one('SELECT * FROM declaration WHERE id = $1', [declId]);
  if (!d) fail(404, 'Fant ikke deklarasjonen.');
  if (d.direction !== 'IMPORT') fail(400, 'Bare innførselsdeklarasjoner kan kobles til en Digitoll-forsendelse.');
  const existing = await one(`SELECT id FROM digitoll_house WHERE declaration_id = $1 AND status <> 'CANCELLED'`, [declId]);
  if (existing) fail(409, 'Deklarasjonen har allerede en Digitoll-forsendelse.', 'HOUSE_EXISTS');
  const items = await query('SELECT description, packages, gross_kg FROM declaration_item WHERE declaration_id = $1 ORDER BY line_no', [declId]);
  const data: any = template('HOUSE');
  const h = data.consignmentHouseLevel;
  const pk = items.reduce((s, i) => s + (Number(i.packages) || 0), 0), gross = items.reduce((s, i) => s + (Number(i.gross_kg) || 0), 0);
  if (pk) h.numberOfPackages = pk;
  if (gross) h.totalGrossMass = Math.round(gross * 1000) / 1000;
  h.goodsDescription = [...new Set(items.map(i => i.description).filter(Boolean))].join('; ').slice(0, 512);
  const consignor = await party(d.exporter_id), consignee = await party(d.importer_id);
  if (consignor) h.consignor = consignor;
  if (consignee) h.consignee = consignee;
  if (d.container && d.container_nos) h.containerIndicator = 1;
  return create(req, 'HOUSE', { data, declaration_id: declId, client_id: d.client_id ?? d.importer_id });
}

export async function update(req: Request, kind: Kind, id: string, b: any) {
  const r = await requireObj(kind, id);
  if (r.status === 'CANCELLED') fail(409, `${LABEL[kind]} er kansellert.`, 'CANCELLED');
  if (b.version != null && Number(b.version) !== r.version) fail(409, 'Meldingen er endret av en annen bruker. Last inn på nytt.', 'VERSION');
  const data = b.data && typeof b.data === 'object' ? b.data : r.data;
  if (r.mrn) {
    const locked = changedKeys(kind, r.data, data);
    if (locked.length) fail(409, `Feltene kan ikke endres etter at MRN er gitt: ${locked.join(', ')}.`, 'LOCKED');
  }
  const links: Record<string, unknown> = {};
  if (kind === 'MASTER' && 'transport_id' in b) links.transport_id = str(b.transport_id);
  if (kind === 'HOUSE' && ('master_id' in b || 'transport_id' in b)) {
    links.master_id = str(b.master_id); links.transport_id = links.master_id ? null : str(b.transport_id);
  }
  for (const [k, v] of Object.entries(links)) if (v) await requireObj(k === 'master_id' ? 'MASTER' : 'TRANSPORT', String(v));
  const cols = { ...columns(kind, data), ...links };
  const keys = Object.keys(cols);
  const changed = JSON.stringify(data) !== JSON.stringify(r.data) || keys.some(k => (r as any)[k] !== (cols as any)[k]);
  if (!changed) return card(kind, id);
  await tx(async c => {
    await c.query(`UPDATE ${TABLE[kind]} SET data = $2, pending_change = (mrn IS NOT NULL), version = version + 1, updated_at = now(), updated_by = $3${keys.map((k, i) => `, ${k} = $${i + 4}`).join('')} WHERE id = $1`,
      [id, JSON.stringify(data), req.user!.id, ...keys.map(k => (cols as any)[k])]);
    await audit(req, { action: 'DIGITOLL_CHANGED', objectType: 'DIGITOLL', objectId: id, detail: { kind, links } }, c);
  });
  return card(kind, id);
}

/**
 * Send (a new message, or an amendment with the same MRN). Rejected on errors; INCOMPLETE when documentation
 * is missing; otherwise accepted. Everything out and in is in digitoll_message.
 */
export async function send(req: Request, kind: Kind, id: string) {
  let r = await requireObj(kind, id);
  if (r.status === 'CANCELLED') fail(409, `${LABEL[kind]} er kansellert.`, 'CANCELLED');
  if (r.mrn && !r.pending_change && r.status !== 'REJECTED') fail(409, 'Ingen endringer å sende.', 'NOTHING_TO_SEND');
  if (kind === 'HOUSE') r = await syncCude(r);
  const res = check(kind, r.mode, r.data, await children(kind, id));
  const op = r.mrn ? 'PUT' : 'POST';
  const errors = res.issues.filter(i => i.lvl === 'err'), incomplete = res.issues.filter(i => i.lvl === 'incomplete');
  const mrn = r.mrn ?? (errors.length ? null : `${new Date().getFullYear().toString().slice(2)}NODT${crypto.randomBytes(6).toString('hex').toUpperCase()}`);
  const status = errors.length ? 'REJECTED' : incomplete.length ? 'INCOMPLETE' : 'ACCEPTED';
  const answer = { status, simulator: true, errors: errors.map(e => ({ path: e.path, rule: e.rule, msg: e.msg })),
    incompleteDocumentationReasons: [...new Set(incomplete.map(i => i.reason).filter(Boolean))], notes: incomplete.map(i => i.msg) };
  await tx(async c => {
    await log(c, kind, id, 'OUT', op, r.mrn, r.data, req.user!.id);
    await log(c, kind, id, 'IN', 'ANSWER', mrn, answer, null);
    await c.query(`UPDATE ${TABLE[kind]} SET status = $2, mrn = $3, answer = $4, pending_change = false, sent_at = now(), version = version + 1, updated_at = now(), updated_by = $5
        ${kind === 'HOUSE' ? ', variant = $6' : ''} WHERE id = $1`, [id, status, mrn, JSON.stringify(answer), req.user!.id, ...(kind === 'HOUSE' ? [res.variant] : [])]);
    await audit(req, { action: 'DIGITOLL_SENT', objectType: 'DIGITOLL', objectId: id, after: { status }, detail: { kind, operation: op, mrn, errors: errors.length, adapter: ADAPTER } }, c);
  });
  return card(kind, id);
}

/** Cancel with a reason; a master or transport with active children cannot be cancelled. */
export async function cancel(req: Request, kind: Kind, id: string, reason: unknown) {
  const r = await requireObj(kind, id);
  if (r.status === 'CANCELLED') fail(409, `${LABEL[kind]} er allerede kansellert.`);
  const why = str(reason);
  if (!why) fail(400, 'Oppgi hvorfor meldingen kanselleres.', 'REASON_REQUIRED');
  if (await children(kind, id)) fail(409, `${LABEL[kind]} har aktive forsendelser koblet til seg. Kanseller eller flytt dem først.`, 'HAS_CHILDREN');
  await tx(async c => {
    if (r.mrn) { await log(c, kind, id, 'OUT', 'DELETE', r.mrn, { reason: why }, req.user!.id); await log(c, kind, id, 'IN', 'ANSWER', r.mrn, { status: 'CANCELLED', simulator: true }, null); }
    await c.query(`UPDATE ${TABLE[kind]} SET status = 'CANCELLED', cancel_reason = $2, pending_change = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, why, req.user!.id]);
    await audit(req, { action: 'DIGITOLL_CANCELLED', objectType: 'DIGITOLL', objectId: id, detail: { kind, reason: why, mrn: r.mrn } }, c);
  });
  return card(kind, id);
}

/** Arrival at the border, registered by hand (Tolletaten's arrival API is not called yet). */
export async function registerArrival(req: Request, id: string) {
  const r = await requireObj('TRANSPORT', id);
  if (!r.mrn) fail(409, 'Transporten er ikke sendt til Tolletaten ennå.');
  await tx(async c => {
    await c.query('UPDATE digitoll_transport SET arrival_registered_at = now(), version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [id, req.user!.id]);
    await audit(req, { action: 'DIGITOLL_ARRIVAL', objectType: 'DIGITOLL', objectId: id, detail: { mrn: r.mrn } }, c);
  });
  return card('TRANSPORT', id);
}

export const forDeclaration = (declId: string) => one(`SELECT id, status, mrn, doc_number FROM digitoll_house WHERE declaration_id = $1 AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 1`, [declId]);
