import type { Request } from 'express';
import type pg from 'pg';
import { one, query, tx, pool } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as docs from '../documents.js';
import { searchName } from '../partners/rules.js';
import { match as matchProduct } from '../products/repo.js';
import { INCOTERMS } from '../declarations/codes.js';
import { provider, PROMPT_VERSION, type Extraction, type IntakeFile } from './provider.js';

/**
 * AI intake (phase 2c): documents in → AI reads them → a draft declaration built from the registers first.
 *
 *  * The AI's values never overwrite what a person entered: only empty header fields are filled.
 *  * Goods lines: the register product (GTIN, then the client's article number, then the supplier's) gives
 *    the checked description, commodity code and origin. A line without a product gets the invoice text, and
 *    a printed commodity code only as a suggestion to check.
 *  * Each goods item keeps where every value came from (declaration_item.source); everything a person must
 *    look at becomes a review point (declaration_review), and nothing is fixed silently.
 *  * Runs in the background (requirements: screens never wait on AI reading); the screen polls the status.
 */
const str = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const iso2 = (v: unknown) => { const x = str(v)?.toUpperCase(); return x && /^[A-Z]{2}$/.test(x) ? x : null; };
const d8 = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const MODE: Record<string, string> = { SEA: '1', RAIL: '2', ROAD: '3', AIR: '4', POST: '5' };
const LOW_CONFIDENCE = 0.8;
const running = new Set<string>();

export const status = () => ({ configured: provider().configured(), model: provider().model(), promptVersion: PROMPT_VERSION });

/** A client that has refused AI processing: no document of theirs may be sent. */
async function aiRefused(...ids: (string | null | undefined)[]) {
  const r = await one('SELECT legal_name FROM business_partner WHERE id = ANY($1) AND ai_off LIMIT 1', [ids.filter(Boolean)]);
  return r?.legal_name as string | undefined;
}

/**
 * Start an intake on documents already stored on the declaration (all of them when none are named).
 * Only a draft without goods items: the AI fills an empty declaration, it never rewrites one.
 */
export async function start(req: Request, declId: string, documentIds?: string[]) {
  if (!provider().configured()) fail(503, 'AI-tjenesten er ikke satt opp (ANTHROPIC_API_KEY mangler i .env).', 'AI_OFF');
  const d = await one('SELECT * FROM declaration WHERE id = $1', [declId]);
  if (!d) fail(404, 'Fant ikke deklarasjonen.');
  if (!['DRAFT', 'RETURNED'].includes(d.status)) fail(409, 'Deklarasjonen kan ikke endres.', 'NOT_EDITABLE');
  if ((await one<{ n: number }>('SELECT COUNT(*) n FROM declaration_item WHERE declaration_id = $1', [declId]))!.n)
    fail(409, 'Deklarasjonen har allerede vareposter. AI-lesing fyller bare en tom deklarasjon.', 'HAS_ITEMS');
  if (await one("SELECT 1 FROM declaration_intake WHERE declaration_id = $1 AND status IN ('QUEUED', 'RUNNING')", [declId]))
    fail(409, 'Dokumentene leses allerede.', 'INTAKE_RUNNING');
  const refused = await aiRefused(d.importer_id, d.client_id);
  if (refused) fail(409, `${refused} har reservert seg mot AI-behandling. Dokumentene sendes ikke til AI-tjenesten.`, 'AI_REFUSED');
  const rows = await query(`SELECT id FROM document WHERE owner_type = 'DECLARATION' AND owner_id = $1 AND removed_at IS NULL
      ${documentIds?.length ? 'AND id = ANY($2)' : ''} ORDER BY uploaded_at`, documentIds?.length ? [declId, documentIds] : [declId]);
  if (!rows.length) fail(400, 'Last opp minst ett dokument (faktura, pakkliste …) først.', 'NO_DOCUMENTS');
  const intake = (await one(`INSERT INTO declaration_intake (declaration_id, document_ids, model, prompt_version, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [declId, rows.map(r => r.id), provider().model(), PROMPT_VERSION, req.user!.id]))!;
  await audit(req, { action: 'AI_INTAKE_STARTED', objectType: 'DECLARATION', objectId: declId, detail: { intake: intake.id, documents: rows.length, model: provider().model(), promptVersion: PROMPT_VERSION } });
  void run(intake.id, req.user!.id).catch(e => console.error('intake:', e));
  return intake.id as string;
}

/** The worker: read the files (checked against their SHA-256), call the AI, build the draft. */
export async function run(intakeId: string, userId: string) {
  if (running.has(intakeId)) return;
  running.add(intakeId);
  try {
    const it = (await one("UPDATE declaration_intake SET status = 'RUNNING', started_at = now() WHERE id = $1 AND status = 'QUEUED' RETURNING *", [intakeId]));
    if (!it) return;
    try {
      const files: IntakeFile[] = [];
      for (const id of it.document_ids as string[]) {
        const f = await docs.read(id);
        if (!f || !f.intact) throw new Error('Et lagret dokument besto ikke integritetskontrollen og ble ikke sendt.');
        files.push({ filename: f.filename, mime: f.mime, buffer: f.buffer, docCode: f.doc_code });
      }
      const r = await provider().extract(files);
      const summary = await tx(async c => {
        await c.query("UPDATE declaration_intake SET status = 'DONE', finished_at = now(), result = $2, usage = $3, model = $4 WHERE id = $1",
          [intakeId, JSON.stringify(r.data), r.usage ? JSON.stringify(r.usage) : null, r.model]);
        return apply(c, it.declaration_id, intakeId, r.data, userId);
      });
      await audit(null, { action: 'AI_INTAKE_DONE', objectType: 'DECLARATION', objectId: it.declaration_id, detail: { intake: intakeId, model: r.model, ...summary } });
    } catch (e) {
      const message = (e as Error).message || 'Ukjent feil';
      await pool.query("UPDATE declaration_intake SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1", [intakeId, message.slice(0, 1000)]);
      await audit(null, { action: 'AI_INTAKE_FAILED', objectType: 'DECLARATION', objectId: it.declaration_id, detail: { intake: intakeId, error: message.slice(0, 300) } });
    }
  } finally { running.delete(intakeId); }
}

/** At start-up: runs cut off by a restart are marked failed (they can be started again). */
export async function recoverInterrupted() {
  await pool.query("UPDATE declaration_intake SET status = 'FAILED', finished_at = now(), error = 'Avbrutt ved omstart av serveren. Start AI-lesingen på nytt.' WHERE status IN ('QUEUED', 'RUNNING')");
}

/* ------------------------------ building the draft ------------------------------ */
type Party = Extraction['supplier'];

/** A partner in the register for what the documents say: org. no., then EORI / VAT no., then the exact name. */
async function findPartner(c: pg.PoolClient, p: Party) {
  const org = d8(p.org_no);
  if (org.length === 9) {
    const r = (await c.query(`SELECT b.id FROM bp_identifier i JOIN business_partner b ON b.id = i.partner_id WHERE i.identifier_type = 'ORG_NO'
        AND replace(i.identifier_value, ' ', '') = $1 AND i.status = 'ACTIVE' AND b.merged_into IS NULL LIMIT 1`, [org])).rows[0];
    if (r) return { id: r.id as string, by: 'ORG_NO' };
  }
  for (const [type, v] of [['EORI', p.eori], ['VAT_NO', p.vat_no]] as const) {
    const val = str(v)?.replace(/\s/g, '').toUpperCase();
    if (!val) continue;
    const r = (await c.query(`SELECT b.id FROM bp_identifier i JOIN business_partner b ON b.id = i.partner_id WHERE i.identifier_type = $1
        AND upper(replace(i.identifier_value, ' ', '')) = $2 AND i.status = 'ACTIVE' AND b.merged_into IS NULL LIMIT 1`, [type, val])).rows[0];
    if (r) return { id: r.id as string, by: type };
  }
  const name = searchName(p.name);
  if (name) {
    const r = (await c.query('SELECT id FROM business_partner WHERE search_name = $1 AND merged_into IS NULL AND status = $2 LIMIT 2', [name, 'ACTIVE'])).rows;
    if (r.length === 1) return { id: r[0].id as string, by: 'NAME' };
    if (r.length > 1) return { id: null, by: 'AMBIGUOUS' };
  }
  return null;
}

async function apply(c: pg.PoolClient, declId: string, intakeId: string, x: Extraction, userId: string) {
  const d = (await c.query('SELECT * FROM declaration WHERE id = $1 FOR UPDATE', [declId])).rows[0];
  const reviews: { line?: number; kind: string; msg: string; data?: unknown }[] = [];
  const set: Record<string, unknown> = {};
  const fill = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== '' && (d[k] === null || d[k] === '' || d[k] === undefined)) set[k] = v; };

  /* Parties: box 2 from the supplier, box 8 from the buyer (when not chosen already). */
  const sup = x.supplier.name ? await findPartner(c, x.supplier) : null;
  if (sup?.id) fill('exporter_id', sup.id);
  else if (x.supplier.name && !d.exporter_id)
    reviews.push({ kind: 'PARTY_UNKNOWN', msg: `Avsender «${x.supplier.name}» finnes ikke i Forretningspartner${sup?.by === 'AMBIGUOUS' ? ' (flere med samme navn)' : ''}. Velg eller opprett partneren (rubrikk 2).`, data: { box: '2', field: 'exporter_id', party: x.supplier } });
  if (!d.importer_id && x.buyer.name) {
    const buy = await findPartner(c, x.buyer);
    if (buy?.id) { fill('importer_id', buy.id); if (!d.client_id) fill('client_id', buy.id); }
    else reviews.push({ kind: 'PARTY_UNKNOWN', msg: `Mottaker «${x.buyer.name}» finnes ikke i Forretningspartner. Velg eller opprett partneren (rubrikk 8).`, data: { box: '8', field: 'importer_id', party: x.buyer } });
  }
  const importerId = (set.importer_id as string) ?? d.importer_id ?? null;
  const exporterId = (set.exporter_id as string) ?? d.exporter_id ?? null;
  if (importerId && await aiRefused(importerId)) throw new Error('Mottakeren har reservert seg mot AI-behandling.');

  /* Header boxes. */
  const cur = str(x.currency)?.toUpperCase();
  fill('currency', cur && /^[A-Z]{3}$/.test(cur) ? cur : null);
  const inc = str(x.incoterms)?.toUpperCase().slice(0, 3);
  fill('incoterms', inc && INCOTERMS.includes(inc) ? inc : null);
  fill('incoterms_place', str(x.incoterms_place));
  fill('invoice_total', x.invoice_total != null && x.invoice_total >= 0 ? x.invoice_total : null);
  fill('dispatch_country', iso2(x.dispatch_country) ?? iso2(x.supplier.country));
  fill('transport_mode', x.transport_mode ? MODE[x.transport_mode] ?? null : null);
  fill('transport_id', str(x.transport_identity));
  fill('transport_nat', iso2(x.transport_nationality));
  if (str(x.container_numbers) && !d.container) { set.container = true; fill('container_nos', str(x.container_numbers)); }
  fill('prev_doc', str(x.export_declaration_ref) ?? str(x.transit_ref));
  fill('own_ref', str(x.invoice_no));
  if (!d.docs?.length) {
    const list: Record<string, unknown>[] = [];
    if (x.invoice_no || x.documents.some(o => o.kind === 'INVOICE')) list.push({ code: 'N380', ref: str(x.invoice_no), ...(str(x.invoice_date) ? { date: x.invoice_date } : {}) });
    for (const o of x.documents.filter(o => o.kind === 'PACKING_LIST')) list.push({ code: 'N271', ref: str(o.number) ?? str(x.invoice_no), ...(str(o.date) ? { date: o.date } : {}) });
    for (const o of x.documents.filter(o => o.kind === 'CMR')) list.push({ code: 'N730', ref: str(o.number), ...(str(o.date) ? { date: o.date } : {}) });
    if (list.length) set.docs = JSON.stringify(list);
  }
  // Freight and insurance shown separately become box 12 lines to confirm (whether they belong in the
  // customs value depends on the delivery terms).
  if (!(Array.isArray(d.value_details) && d.value_details.length)) {
    const b12: Record<string, unknown>[] = [];
    if (x.freight && x.freight > 0) b12.push({ kind: 'ADD', type: 'FRAKT', amount: x.freight, currency: 'INV', basis: 'GROSS', text: 'Fra faktura (AI)' });
    if (x.insurance && x.insurance > 0) b12.push({ kind: 'ADD', type: 'FORSIKRING', amount: x.insurance, currency: 'INV', basis: 'VALUE', text: 'Fra faktura (AI)' });
    if (x.discount && x.discount > 0) b12.push({ kind: 'DED', type: 'RABATT', amount: x.discount, currency: 'INV', basis: 'VALUE', text: 'Fra faktura (AI)' });
    if (b12.length) {
      set.value_details = JSON.stringify(b12);
      reviews.push({ kind: 'BOX12', msg: `Fakturaen viser ${b12.map(b => `${b.type === 'FRAKT' ? 'frakt' : b.type === 'FORSIKRING' ? 'forsikring' : 'rabatt'} ${b.amount}`).join(', ')} ${cur ?? ''}. De er ført i rubrikk 12 — kontroller mot leveringsvilkåret${inc ? ` (${inc})` : ''}.`, data: { box: '12' } });
    }
  }
  if (x.ched_ref) reviews.push({ kind: 'CHED', msg: `Dokumentene viser CHED ${x.ched_ref}. Før det som VT på de varepostene det gjelder (rubrikk 44).`, data: { ched: x.ched_ref } });

  /* Goods items. */
  const origin = iso2(x.origin_country);
  let n = 0, matched = 0;
  for (const l of x.lines) {
    const price = l.line_total ?? (l.quantity != null && l.unit_price != null ? Math.round(l.quantity * l.unit_price * 100) / 100 : null);
    if (!price && l.quantity == null) { reviews.push({ kind: 'LINE_SKIPPED', msg: `Fakturalinjen «${l.description}» har verken mengde eller beløp (ikke levert?) og er ikke tatt med.`, data: { line: l } }); continue; }
    const lineNo = ++n;
    const gtin = d8(l.gtin);
    const hit = await matchProduct({ gtin: gtin.length >= 8 ? gtin : undefined, clientArt: l.article_no ?? undefined, supplierArt: l.article_no ?? undefined, ownerId: importerId, supplierId: exporterId });
    const p = hit?.product;
    const printed = d8(l.hs_code);
    const src: Record<string, string> = {};
    const item: Record<string, unknown> = { line_no: lineNo, price, net_kg: l.net_kg, gross_kg: l.gross_kg, packages: l.packages != null ? Math.round(l.packages) : null,
      article_no: str(l.article_no), gtin: gtin.length >= 8 ? gtin : null, procedure: d.decl_type === '5' ? '5000' : d.decl_type === '7' ? '7100' : '4000' };
    if (p) {
      matched++;
      Object.assign(item, { product_id: p.id, description: p.descr ?? l.description, code: p.code, origin: p.origin ?? iso2(l.origin) ?? origin });
      Object.assign(src, { description: 'PRODUCT', code: p.code ? 'PRODUCT' : 'NONE', origin: p.origin ? 'PRODUCT' : 'INVOICE' });
      if (p.code && printed.length >= 6 && !p.code.startsWith(printed.slice(0, 6)))
        reviews.push({ line: lineNo, kind: 'CODE_DIFFERS', msg: `Varepost ${lineNo}: fakturaen viser varenummer ${printed}, men produktet ${p.product_no} er klassifisert som ${p.code}. Produktregisteret er brukt.`, data: { invoice: printed, product: p.code } });
      if (p.status !== 'CHECKED') reviews.push({ line: lineNo, kind: 'PRODUCT_NOT_CHECKED', msg: `Varepost ${lineNo}: produkt ${p.product_no} er ikke kontrollert (${p.status}). Kontroller varenummeret.` });
    } else {
      const code = printed.length === 8 && (await c.query("SELECT 1 FROM tariff WHERE code = $1 AND level = 'Code'", [printed])).rowCount ? printed : null;
      Object.assign(item, { description: l.description, code, origin: iso2(l.origin) ?? origin });
      Object.assign(src, { description: 'INVOICE', code: code ? 'INVOICE' : 'NONE', origin: iso2(l.origin) ? 'INVOICE' : origin ? 'DOCUMENT' : 'NONE' });
      reviews.push({ line: lineNo, kind: 'PRODUCT_UNMATCHED', msg: `Varepost ${lineNo}: «${l.description}»${l.article_no ? ` (art. ${l.article_no})` : ''} finnes ikke i produktregisteret. ${code ? `Varenummer ${code} er hentet fra fakturaen — kontroller det.` : 'Klassifiser varen (rubrikk 33).'}`,
        data: { article_no: l.article_no, gtin: item.gtin, description: l.description, code } });
    }
    if (l.confidence < LOW_CONFIDENCE) reviews.push({ line: lineNo, kind: 'LOW_CONFIDENCE', msg: `Varepost ${lineNo}: AI-en er usikker på lesingen (${Math.round(l.confidence * 100)} %). Kontroller linjen mot dokumentet.` });
    if (l.net_kg == null) reviews.push({ line: lineNo, kind: 'WEIGHT_MISSING', msg: `Varepost ${lineNo}: nettovekt står ikke i dokumentene. Fyll inn rubrikk 38.` });
    const source = { intake: intakeId, document: l.document_index, page: l.page, confidence: l.confidence, fields: src,
      read: { article_no: l.article_no, gtin: l.gtin, description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, line_total: l.line_total, hs_code: l.hs_code, origin: l.origin } };
    const cols = Object.keys(item).filter(k => item[k] !== undefined);
    await c.query(`INSERT INTO declaration_item (declaration_id, source${cols.map(k => ', ' + k).join('')}) VALUES ($1, $2${cols.map((_, i) => `, $${i + 3}`).join('')})`,
      [declId, JSON.stringify(source), ...cols.map(k => item[k])]);
  }

  /* Totals: the lines against the invoice total and the documents' weights. */
  const sum = x.lines.reduce((a, l) => a + (l.line_total ?? (l.quantity ?? 0) * (l.unit_price ?? 0)), 0);
  if (x.invoice_total != null && Math.abs(sum - x.invoice_total) > 0.5)
    reviews.push({ kind: 'TOTALS', msg: `Summen av fakturalinjene (${sum.toFixed(2)}) avviker fra fakturatotalen (${x.invoice_total.toFixed(2)}). Kontroller frakt, rabatt og linjer som mangler.`, data: { box: '22' } });
  const net = x.lines.reduce((a, l) => a + (l.net_kg ?? 0), 0);
  if (x.total_net_kg != null && net > 0 && Math.abs(net - x.total_net_kg) > Math.max(0.5, x.total_net_kg * 0.01))
    reviews.push({ kind: 'TOTALS', msg: `Nettovekten på linjene (${net.toFixed(3)} kg) avviker fra totalen i dokumentene (${x.total_net_kg} kg).`, data: { box: '38' } });
  for (const r of x.remarks) reviews.push({ kind: 'AI_REMARK', msg: `AI-merknad: ${r}` });

  const cols = Object.keys(set);
  if (cols.length)
    await c.query(`UPDATE declaration SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [declId, userId, ...cols.map(k => set[k])]);
  else await c.query('UPDATE declaration SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [declId, userId]);
  for (const r of reviews)
    await c.query('INSERT INTO declaration_review (declaration_id, intake_id, line_no, kind, msg, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [declId, intakeId, r.line ?? null, r.kind, r.msg, r.data ? JSON.stringify(r.data) : null]);
  return { items: n, matched, reviews: reviews.length, filled: cols };
}

/* ------------------------------ review points ------------------------------ */
export const reviewsFor = (declId: string) => query(`SELECT r.*, u.name cleared_by_name FROM declaration_review r LEFT JOIN users u ON u.id = r.cleared_by
    WHERE r.declaration_id = $1 ORDER BY r.status DESC, r.line_no NULLS FIRST, r.created_at`, [declId]);
export const intakesFor = (declId: string) => query(`SELECT id, status, model, prompt_version, error, created_at, started_at, finished_at,
    cardinality(document_ids) documents, usage FROM declaration_intake WHERE declaration_id = $1 ORDER BY created_at DESC`, [declId]);

export async function clearReview(req: Request, declId: string, reviewId: string, note: unknown, reopen = false) {
  const r = await one('SELECT * FROM declaration_review WHERE id = $1 AND declaration_id = $2', [reviewId, declId]);
  if (!r) fail(404, 'Fant ikke kontrollpunktet.');
  const d = await one('SELECT status FROM declaration WHERE id = $1', [declId]);
  if (!['DRAFT', 'RETURNED'].includes(d!.status)) fail(409, 'Deklarasjonen kan ikke endres.', 'NOT_EDITABLE');
  await tx(async c => {
    if (reopen) await c.query("UPDATE declaration_review SET status = 'OPEN', cleared_by = NULL, cleared_at = NULL, clear_note = NULL WHERE id = $1", [reviewId]);
    else await c.query("UPDATE declaration_review SET status = 'CLEARED', cleared_by = $2, cleared_at = now(), clear_note = $3 WHERE id = $1", [reviewId, req.user!.id, str(note)]);
    await audit(req, { action: reopen ? 'REVIEW_REOPENED' : 'REVIEW_CLEARED', objectType: 'DECLARATION', objectId: declId, detail: { review: reviewId, kind: r!.kind, note: str(note) } }, c);
  });
}

/** Create the business partner the AI read (review point PARTY_UNKNOWN) and put it in its box. */
export async function createPartnerFromReview(req: Request, declId: string, reviewId: string) {
  const r = await one("SELECT * FROM declaration_review WHERE id = $1 AND declaration_id = $2 AND kind = 'PARTY_UNKNOWN'", [reviewId, declId]);
  if (!r) fail(404, 'Fant ikke kontrollpunktet.');
  const d = await one('SELECT * FROM declaration WHERE id = $1', [declId]);
  if (!['DRAFT', 'RETURNED'].includes(d!.status)) fail(409, 'Deklarasjonen kan ikke endres.', 'NOT_EDITABLE');
  const p: Party = r!.data.party, field: string = r!.data.field;
  if (!p?.name) fail(400, 'Kontrollpunktet har ikke noe navn å opprette partneren med.');
  const country = iso2(p.country) ?? (field === 'importer_id' ? 'NO' : iso2(d!.dispatch_country));
  if (!country) fail(400, 'Landet til avsenderen står ikke i dokumentene. Opprett partneren i Forretningspartner og velg den i rubrikk 2.', 'COUNTRY_MISSING');
  const id = await tx(async c => {
    const b = (await c.query(`INSERT INTO business_partner (legal_name, search_name, registration_country, source, created_by, updated_by) VALUES ($1,$2,$3,'AI',$4,$4) RETURNING id, partner_no`,
      [p.name, searchName(p.name), country, req.user!.id])).rows[0];
    if (p.street || p.city) await c.query(`INSERT INTO bp_address (partner_id, address_type, street, postal_code, city, country_code, is_standard) VALUES ($1,'REGISTERED',$2,$3,$4,$5,true)`,
      [b.id, str(p.street), str(p.postal_code), str(p.city), country]);
    const org = d8(p.org_no);
    if (org.length === 9 && country === 'NO') await c.query(`INSERT INTO bp_identifier (partner_id, identifier_type, identifier_value, issuing_country, is_primary, source) VALUES ($1,'ORG_NO',$2,'NO',true,'AI')`, [b.id, org]);
    if (str(p.eori)) await c.query(`INSERT INTO bp_identifier (partner_id, identifier_type, identifier_value, source) VALUES ($1,'EORI',$2,'AI')`, [b.id, str(p.eori)!.replace(/\s/g, '').toUpperCase()]);
    if (str(p.vat_no)) await c.query(`INSERT INTO bp_identifier (partner_id, identifier_type, identifier_value, source) VALUES ($1,'VAT_NO',$2,'AI')`, [b.id, str(p.vat_no)!.replace(/\s/g, '').toUpperCase()]);
    await c.query(`INSERT INTO bp_role (partner_id, role_code) VALUES ($1, $2)`, [b.id, field === 'importer_id' ? 'IMP' : 'EXP']);
    const f = field === 'importer_id' ? 'importer_id' : 'exporter_id';
    await c.query(`UPDATE declaration SET ${f} = $2${f === 'importer_id' ? ', client_id = coalesce(client_id, $2)' : ''}, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`, [declId, b.id, req.user!.id]);
    await c.query("UPDATE declaration_review SET status = 'CLEARED', cleared_by = $2, cleared_at = now(), clear_note = $3 WHERE id = $1", [reviewId, req.user!.id, `Opprettet ${b.partner_no}`]);
    await audit(req, { action: 'PARTNER_CREATED', objectType: 'PARTNER', objectId: b.id, after: { legal_name: p.name, registration_country: country }, detail: { from: 'AI', declaration: declId } }, c);
    return b.id as string;
  });
  return id;
}
