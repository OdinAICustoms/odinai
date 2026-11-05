import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type pg from 'pg';
import { tx } from '../db.js';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { searchName, digits } from '../partners/rules.js';
import { normId } from '../products/repo.js';

/**
 * The move from ODIN LINK 2.37 (SQLite) into OdinAi.
 *
 *  * Works on a copy of the SQLite file (with its -wal), so ODIN LINK's own database is never opened.
 *  * One transaction: everything or nothing. Without `commit` the transaction is rolled back and only the
 *    report comes back (dry run); no files are written either.
 *  * Every record keeps its ODIN LINK id in legacy_id, so a second run skips what is already moved.
 *  * Partner and product numbers (BP-00005, PRD-00003) are kept; the number sequences continue after them.
 *  * Nothing is fixed silently: values OdinAi cannot accept are left empty and listed in the report.
 */

export interface LinkReport {
  dryRun: boolean;
  moved: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
  notMoved: Record<string, number>;
}

type Row = Record<string, any>;
interface Opts { dbPath: string; filesDir?: string; commit?: boolean; fileStore?: string }

class DryRun extends Error { constructor(public report: LinkReport) { super('dry run'); } }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
/** SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS". */
const ts = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v) ? v.replace(' ', 'T').slice(0, 19) + 'Z' : null);
const bool = (v: unknown) => v === 1 || v === true || v === '1';
const num = (v: unknown) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const rowStatus = (s: unknown) => (s === 'ACTIVE' || s == null ? 'ACTIVE' : 'ENDED');

/** Open a private copy of the ODIN LINK database. */
function openCopy(dbPath: string) {
  if (!fs.existsSync(dbPath)) throw new Error(`Fant ikke ODIN LINK-databasen: ${dbPath}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odinlink-'));
  const copy = path.join(dir, 'odin-link.db');
  fs.copyFileSync(dbPath, copy);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
  // node:sqlite is loaded at run time (Node 22.5+), so bundlers and tests never have to resolve it.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(copy);
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const cols = (t: string) => new Set<string>(db.prepare(`PRAGMA table_info("${t}")`).all().map((c: Row) => c.name));
  const all = (sql: string, ...p: unknown[]): Row[] => db.prepare(sql).all(...p);
  const count = (t: string, where = '') => (has(t) ? Number(db.prepare(`SELECT count(*) n FROM "${t}" ${where}`).get().n) : 0);
  const close = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { has, cols, all, count, close };
}

export async function importOdinLink(opts: Opts): Promise<LinkReport> {
  const L = openCopy(opts.dbPath);
  const report: LinkReport = { dryRun: !opts.commit, moved: {}, skipped: {}, warnings: [], notMoved: {} };
  const moved = (k: string, n = 1) => { report.moved[k] = (report.moved[k] ?? 0) + n; };
  const skipped = (k: string) => { report.skipped[k] = (report.skipped[k] ?? 0) + 1; };
  const warn = (s: string) => report.warnings.push(s);
  const filesDir = opts.filesDir ?? path.join(path.dirname(opts.dbPath), 'files');
  const fileStore = opts.fileStore ?? config.fileStore;
  const pendingFiles: { from: string; to: string }[] = [];
  try {
    if (!L.has('business_partners')) throw new Error('Dette ser ikke ut som en ODIN LINK-database (tabellen business_partners mangler).');
    await tx(async c => {
      const q = (sql: string, p: unknown[] = []) => c.query(sql, p).then(r => r.rows as Row[]);
      const one = (sql: string, p: unknown[] = []) => q(sql, p).then(r => r[0] ?? null);
      const log = (action: string, objectType: string, objectId: string, detail: Row) => audit(null, { action, objectType, objectId, detail: { source: 'ODIN LINK', ...detail } }, c);

      /* Users are matched on e-mail (OdinAi accounts are created separately), for created_by / checked_by. */
      const userMap = new Map<string, string>();
      if (L.has('users')) {
        const ours = new Map((await q('SELECT id, lower(email) email FROM users')).map(u => [u.email, u.id]));
        for (const u of L.all('SELECT id, email FROM users')) { const id = ours.get(String(u.email ?? '').toLowerCase()); if (id) userMap.set(u.id, id); }
      }
      const user = (v: unknown) => (v ? userMap.get(String(v)) ?? null : null);

      /* ---- Business partners ---- */
      const partnerMap = new Map<string, string>();          // ODIN LINK partner id / operator id -> OdinAi uuid
      const fresh = new Set<string>();                         // partners inserted in this run (children follow)
      for (const r of await q("SELECT id, legacy_id FROM business_partner WHERE legacy_id IS NOT NULL")) partnerMap.set(r.legacy_id, r.id);
      const partners = L.all('SELECT * FROM business_partners ORDER BY partner_no');
      for (const p of partners) {
        if (partnerMap.has(p.id)) { skipped('partners'); continue; }
        const clash = await one('SELECT 1 FROM business_partner WHERE partner_no = $1', [p.partner_no]);
        if (clash) warn(`Partner ${p.partner_no} ${p.legal_name}: nummeret er allerede brukt i OdinAi, fikk nytt nummer.`);
        const category = p.category === 'PERSON' ? 'PERSON' : 'ORGANIZATION';
        const vals = [category, String(p.legal_name).trim(), searchName(p.legal_name), String(p.registration_country || 'NO').toUpperCase().slice(0, 2), String(p.language || 'NO').toUpperCase(),
          bool(p.is_client), p.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', p.notes || null, bool(p.deposit_paid), num(p.deposit_amount),
          DATE.test(p.deposit_date ?? '') ? p.deposit_date : null, p.id, ts(p.created_at), user(p.created_by), ts(p.updated_at), user(p.updated_by)];
        const withNo = p.partner_no && !clash;
        const ins = await one(`INSERT INTO business_partner (${withNo ? 'partner_no, ' : ''}category, legal_name, search_name, registration_country, language, is_client,
            status, notes, deposit_paid, deposit_amount, deposit_date, source, legacy_id, version, created_at, created_by, updated_at, updated_by)
          VALUES (${withNo ? '$17, ' : ''}$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ODIN_LINK',$12,1,coalesce($13::timestamptz, now()),$14,coalesce($15::timestamptz, now()),$16) RETURNING id, partner_no`,
          withNo ? [...vals, p.partner_no] : vals);
        partnerMap.set(p.id, ins!.id); fresh.add(p.id);
        if (p.legacy_operator_id && p.legacy_operator_id !== p.id) partnerMap.set(p.legacy_operator_id, ins!.id);
        moved('partners');
        await log('PARTNER_IMPORTED', 'PARTNER', ins!.id, { partnerNo: ins!.partner_no, legacyId: p.id });
      }
      // Operators (pre-partner customers) point at the same partner through legacy_operator_id.
      for (const p of partners) if (p.legacy_operator_id && partnerMap.has(p.id) && !partnerMap.has(p.legacy_operator_id)) partnerMap.set(p.legacy_operator_id, partnerMap.get(p.id)!);
      for (const p of partners) if (p.merged_into && fresh.has(p.id) && partnerMap.has(p.merged_into))
        await q("UPDATE business_partner SET merged_into = $2, status = 'INACTIVE' WHERE id = $1", [partnerMap.get(p.id), partnerMap.get(p.merged_into)]);
      const pid = (legacy: unknown) => (legacy ? partnerMap.get(String(legacy)) ?? null : null);
      const forFresh = (rows: Row[], key = 'partner_id') => rows.filter(r => fresh.has(r[key]));
      const dateOrNull = (v: unknown, what: string) => {
        if (v == null || v === '') return null;
        if (DATE.test(String(v))) return String(v);
        warn(`${what}: ugyldig dato «${v}» ble utelatt.`); return null;
      };

      for (const a of forFresh(L.all('SELECT * FROM business_partner_addresses'))) {
        await q(`INSERT INTO bp_address (partner_id, address_type, address_name, street, postal_code, city, region, country_code, location_code, is_standard, valid_from, valid_to, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [pid(a.partner_id), a.address_type || 'REGISTERED', a.address_name, a.street, a.postal_code, a.city, a.region, String(a.country_code || 'NO').toUpperCase().slice(0, 2), a.location_code,
            bool(a.is_standard), dateOrNull(a.valid_from, 'Adresse'), dateOrNull(a.valid_to, 'Adresse'), rowStatus(a.status)]);
        moved('addresses');
      }
      for (const i of forFresh(L.all('SELECT * FROM business_partner_identifiers'))) {
        const vt = dateOrNull(i.valid_to, 'Identifikator');
        await q(`INSERT INTO bp_identifier (partner_id, identifier_type, identifier_value, issuing_country, is_primary, valid_from, valid_to, status, source,
            check_status, check_name, check_address, checked_at, check_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ODIN_LINK',$9,$10,$11,$12,$13)`,
          [pid(i.partner_id), i.identifier_type, String(i.identifier_value).trim(), i.issuing_country, bool(i.is_primary), dateOrNull(i.valid_from, 'Identifikator'), vt,
            vt && vt < today() ? 'ENDED' : 'ACTIVE', i.check_status, i.check_name, i.check_address, ts(i.checked_at), i.check_error]);
        moved('identifiers');
      }
      for (const r of forFresh(L.all('SELECT * FROM business_partner_roles'))) {
        await q('INSERT INTO bp_role (partner_id, role_code, valid_from, valid_to, status, notes) VALUES ($1,$2,$3,$4,$5,$6)',
          [pid(r.partner_id), r.role_code, dateOrNull(r.valid_from, 'Rolle'), dateOrNull(r.valid_to, 'Rolle'), rowStatus(r.status), r.notes]);
        moved('roles');
      }
      for (const k of forFresh(L.all('SELECT * FROM business_partner_contacts'))) {
        await q(`INSERT INTO bp_contact (partner_id, contact_type, contact_name, department, email, telephone, is_primary, clearance_mail, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [pid(k.partner_id), ['CUSTOMS', 'GENERAL', 'FINANCE'].includes(k.contact_type) ? k.contact_type : 'GENERAL', k.contact_name, k.department, k.email, k.telephone,
            bool(k.is_primary), bool(k.notify_clearance), rowStatus(k.status)]);
        moved('contacts');
      }
      if (L.has('business_partner_registry')) for (const g of forFresh(L.all('SELECT * FROM business_partner_registry'))) {
        let data: unknown, roles: unknown = null;
        try { data = JSON.parse(g.data); roles = g.roles ? JSON.parse(g.roles) : null; } catch { warn(`Brønnøysund-data for ${g.org_no} kunne ikke leses og ble utelatt.`); continue; }
        await q(`INSERT INTO bp_registry (partner_id, org_no, vat_registered, bankrupt, winding_up, forced_dissolution, deleted, data, roles, fetched_at, fetch_error)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()),$11)`,
          [pid(g.partner_id), g.org_no, g.vat_registered == null ? null : bool(g.vat_registered), g.bankrupt == null ? null : bool(g.bankrupt), g.winding_up == null ? null : bool(g.winding_up),
            g.forced_dissolution == null ? null : bool(g.forced_dissolution), g.deleted == null ? null : bool(g.deleted), JSON.stringify(data), roles ? JSON.stringify(roles) : null, ts(g.fetched_at), g.fetch_error]);
        moved('registry');
      }
      for (const t of ['business_partner_relationships', 'business_partner_fullmakt', 'customer_prices', 'partner_invoicing_settings'])
        if (L.count(t)) report.notMoved[t] = L.count(t);

      /* ---- Duty credit accounts (box 48) ---- */
      if (L.has('credit_agreements')) for (const a of L.all('SELECT * FROM credit_agreements')) {
        const partner = pid(a.partner_id) ?? pid(a.holder);
        if (!partner) { warn(`Kredittkonto ${a.account}: fant ikke innehaveren (${a.holder}${a.org_no ? ', org.nr. ' + a.org_no : ''}); ikke flyttet.`); continue; }
        if (await one('SELECT 1 FROM bp_credit_account WHERE account = $1', [a.account])) { skipped('creditAccounts'); continue; }
        const active = bool(a.active) && !(a.valid_to && a.valid_to < today());
        await q('INSERT INTO bp_credit_account (partner_id, account, payment_type, valid_to, status) VALUES ($1,$2,$3,$4,$5)',
          [partner, String(a.account).trim(), a.payment_type === 'TOLLKREDITT' ? 'TOLLKREDITT' : 'DAGSOPPGJOR', dateOrNull(a.valid_to, 'Kredittkonto'), active ? 'ACTIVE' : 'ENDED']);
        if (!/^\d+$/.test(String(a.account).trim())) warn(`Kredittkonto «${a.account}» er ikke et kontonummer. Kontroller den på partnerkortet (fanen Tollkreditt).`);
        moved('creditAccounts');
      }

      /* ---- Price list (Odin's own items; client prices are listed under notMoved when there are any) ---- */
      if (L.has('price_items')) for (const it of L.all('SELECT * FROM price_items')) {
        const ours = await one('SELECT price, free_lines FROM price_item WHERE code = $1', [it.code]);
        if (!ours) { report.notMoved['price_items:' + it.code] = 1; continue; }
        if (Number(ours.price) !== Number(it.price) || (ours.free_lines ?? null) !== (it.free_lines ?? null)) {
          await q('UPDATE price_item SET price = $2, free_lines = $3 WHERE code = $1', [it.code, Number(it.price) || 0, it.free_lines ?? null]);
          moved('priceItems');
        }
      }

      /* ---- Products ---- */
      const productMap = new Map<string, string>();
      for (const r of await q('SELECT id, legacy_id FROM product WHERE legacy_id IS NOT NULL')) productMap.set(r.legacy_id, r.id);
      const freshProducts = new Set<string>();
      if (L.has('products')) for (const p of L.all('SELECT * FROM products ORDER BY product_no, created_at')) {
        if (productMap.has(p.id)) { skipped('products'); continue; }
        const label = `Produkt ${p.product_no ?? ''} ${p.name}`.trim();
        const owner = pid(p.owner_id);
        if (p.owner_id && !owner) warn(`${label}: klienten (${p.owner_id}) finnes ikke blant partnerne; produktet flyttes uten klient.`);
        const d = digits(p.code);
        let code: string | null = d.length === 8 ? d : null, notes = p.notes || null;
        if (d && !code) { warn(`${label}: varenummeret «${p.code}» har ikke 8 siffer og ble utelatt.`); notes = [notes, `Varenummer i ODIN LINK: ${p.code}`].filter(Boolean).join('\n'); }
        let status = ['DRAFT', 'REVIEW', 'CHECKED', 'EXPIRED', 'BLOCKED'].includes(p.status) ? p.status : 'DRAFT';
        if (status === 'CHECKED' && !code) { status = 'REVIEW'; warn(`${label}: var kontrollert, men uten gyldig varenummer; satt til «Under kontroll».`); }
        const basis = ['BKU', 'RULING', 'OTHER'].includes(p.basis) ? p.basis : null;
        const clash = p.product_no && (await one('SELECT 1 FROM product WHERE product_no = $1', [p.product_no]));
        if (clash) warn(`${label}: nummeret er allerede brukt i OdinAi, fikk nytt nummer.`);
        const vals = [owner, pid(p.supplier_id), String(p.name).trim(), String(p.descr || p.name).trim(), code, p.origin ? String(p.origin).toUpperCase().slice(0, 2) : null,
          p.pref_basis, p.supp, num(p.net), num(p.gross), num(p.price), p.currency, status, p.status_reason, basis, p.reference_no, dateOrNull(p.valid_to, label),
          user(p.checked_by), ts(p.checked_at), notes, p.active == null ? true : bool(p.active), p.id, ts(p.created_at), ts(p.updated_at)];
        const withNo = p.product_no && !clash;
        const ins = await one(`INSERT INTO product (${withNo ? 'product_no, ' : ''}owner_id, supplier_id, name, descr, code, origin, pref_basis, supp_unit, net_kg, gross_kg, price, currency,
            status, status_reason, basis, reference_no, valid_to, checked_by, checked_at, notes, active, created_from, legacy_id, created_at, updated_at)
          VALUES (${withNo ? '$25, ' : ''}$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'ODIN_LINK',$22,coalesce($23::timestamptz, now()),coalesce($24::timestamptz, now()))
          RETURNING id, product_no`, withNo ? [...vals, p.product_no] : vals);
        productMap.set(p.id, ins!.id); freshProducts.add(p.id);
        moved('products');
        const ident = async (type: 'GTIN' | 'CLIENT_ART', value: unknown, partner: string | null) => {
          const v = String(value ?? '').trim(); if (!v) return;
          const norm = type === 'GTIN' ? digits(v) : normId(v);
          if (!norm) return;
          const taken = await one(`SELECT 1 FROM product_identifier WHERE type = $1 AND norm = $2 AND coalesce(partner_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`, [type, norm, partner]);
          if (taken) { warn(`${label}: ${type === 'GTIN' ? 'GTIN' : 'artikkelnummer'} ${v} er allerede brukt på et annet produkt; ikke lagt til.`); return; }
          await q("INSERT INTO product_identifier (product_id, type, value, norm, partner_id, source) VALUES ($1,$2,$3,$4,$5,'ODIN_LINK')", [ins!.id, type, v, norm, type === 'GTIN' ? null : partner]);
          moved('productIdentifiers');
        };
        await ident('GTIN', p.gtin, null);
        await ident('CLIENT_ART', p.sku, owner);
        await log('PRODUCT_IMPORTED', 'PRODUCT', ins!.id, { productNo: ins!.product_no, legacyId: p.id });
      }
      // Merges after all products exist.
      if (L.has('products')) for (const p of L.all('SELECT id, merged_into FROM products WHERE merged_into IS NOT NULL'))
        if (freshProducts.has(p.id) && productMap.has(p.merged_into)) await q('UPDATE product SET merged_into = $2, active = false WHERE id = $1', [productMap.get(p.id), productMap.get(p.merged_into)]);
      if (L.has('product_history')) for (const h of L.all('SELECT * FROM product_history ORDER BY id')) {
        if (!freshProducts.has(h.product_id)) continue;
        await q('INSERT INTO product_history (product_id, field, old_value, new_value, basis, user_id, at) VALUES ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()))',
          [productMap.get(h.product_id), h.field, h.old_value, h.new_value, h.basis, user(h.user_id), ts(h.at)]);
        moved('productHistory');
      }

      /* ---- RT permits ---- */
      const rtMap = new Map<string, string>();
      for (const r of await q('SELECT id, legacy_id FROM rt_permit WHERE legacy_id IS NOT NULL')) rtMap.set(r.legacy_id, r.id);
      if (L.has('rt_permits')) for (const r of L.all('SELECT * FROM rt_permits ORDER BY valid_from, created_at')) {
        if (rtMap.has(r.id)) { skipped('rtPermits'); continue; }
        const label = `RT-tillatelse «${r.product_name}»`;
        if (!DATE.test(r.valid_from ?? '') || !DATE.test(r.valid_to ?? '') || r.valid_to < r.valid_from) { warn(`${label}: ugyldig gyldighet (${r.valid_from} – ${r.valid_to}); ikke flyttet.`); continue; }
        const holder = pid(r.holder_partner_id);
        if (!holder) warn(`${label}: innehaveren ${r.holder_name ?? ''} finnes ikke blant partnerne; velg innehaver på tillatelsen.`);
        const d = digits(r.tariff_code);
        const code = d.length === 8 ? d : null;
        const notes = [r.ref_internal ? `Intern referanse: ${r.ref_internal}` : null,
          d && !code ? `Varenummer i ODIN LINK: ${r.tariff_code} (ikke 8 siffer)` : null].filter(Boolean).join('\n') || null;
        if (d && !code) warn(`${label}: varenummeret «${r.tariff_code}» har ikke 8 siffer og ble utelatt. Kontroller mot vedtaksbrevet og rett på tillatelsen.`);
        const product = r.product_id ? productMap.get(r.product_id) ?? null : null;
        const ins = await one(`INSERT INTO rt_permit (product_id, holder_id, holder_org_no, holder_name, product_name, tariff_code, case_ref, skriv_tall, rate_tall, skriv_toes, rate_toes,
            rate_unit, duty_code, valid_from, valid_to, sku, gtin, notes, active, legacy_id, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,coalesce($21::timestamptz, now()),coalesce($22::timestamptz, now())) RETURNING id, permit_no`,
          [product, holder, r.holder_org_no ? digits(r.holder_org_no) : null, r.holder_name, String(r.product_name).trim(), code, r.case_ref, r.skriv_tall, num(r.rate_tall), r.skriv_toes, num(r.rate_toes),
            r.rate_unit || 'KR_PER_KG', r.duty_code || 'RT100', r.valid_from, r.valid_to, r.sku, r.gtin, notes, r.active == null ? true : bool(r.active), r.id, ts(r.created_at), ts(r.updated_at)]);
        rtMap.set(r.id, ins!.id);
        moved('rtPermits');
        if (!product) warn(`${ins!.permit_no} «${r.product_name}»: ikke knyttet til et produkt. Bruk «Opprett produkt fra tillatelsen» under Produkter › RT-tillatelser.`);
        await log('RT_IMPORTED', 'PRODUCT', ins!.id, { permitNo: ins!.permit_no, legacyId: r.id });
        if (r.document_path) warn(`${ins!.permit_no}: vedtaksbrevet lå som fil (${r.document_path}) utenfor dokumentarkivet i ODIN LINK; last det opp på tillatelsen.`);
      }

      /* ---- Documents: decision letters and product files ---- */
      if (L.has('attachments')) {
        const cols = L.cols('attachments');
        const where = ['rt_id IS NOT NULL', cols.has('product_id') ? 'product_id IS NOT NULL' : null].filter(Boolean).join(' OR ');
        for (const a of L.all(`SELECT * FROM attachments WHERE ${where}`)) {
          const owner = a.rt_id ? { type: 'RT_PERMIT', id: rtMap.get(a.rt_id) } : { type: 'PRODUCT', id: productMap.get(a.product_id) };
          if (!owner.id) { warn(`Dokument ${a.filename}: tilhører en tillatelse/et produkt som ikke ble flyttet.`); continue; }
          if (await one('SELECT 1 FROM document WHERE owner_type = $1 AND owner_id = $2 AND sha256 = $3', [owner.type, owner.id, a.sha256])) { skipped('documents'); continue; }
          const src = path.join(filesDir, ...String(a.storage_path).split(/[\\/]/));
          if (!fs.existsSync(src)) { warn(`Dokument ${a.filename}: filen finnes ikke i ${filesDir}; ikke flyttet.`); continue; }
          const buffer = fs.readFileSync(src);
          const sha = crypto.createHash('sha256').update(buffer).digest('hex');
          if (sha !== a.sha256) { warn(`Dokument ${a.filename}: filen stemmer ikke med kontrollsummen i ODIN LINK; ikke flyttet.`); continue; }
          const rel = path.join(sha.slice(0, 2), sha.slice(2, 4), sha);
          pendingFiles.push({ from: src, to: path.join(fileStore, rel) });
          await q(`INSERT INTO document (owner_type, owner_id, doc_code, filename, mime, size_bytes, sha256, storage_path, uploaded_by, uploaded_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()))`,
            [owner.type, owner.id, a.doc_code, a.filename, a.mime, buffer.length, sha, rel, user(a.uploaded_by), ts(a.created_at)]);
          moved('documents');
        }
      }

      /* Numbers continue after the moved ones. */
      await q("SELECT setval('bp_number', coalesce((SELECT max(substring(partner_no FROM 4)::int) FROM business_partner WHERE partner_no ~ '^BP-[0-9]+$'), 0) + 1, false)");
      await q("SELECT setval('product_number', coalesce((SELECT max(substring(product_no FROM 5)::int) FROM product WHERE product_no ~ '^PRD-[0-9]+$'), 0) + 1, false)");

      /* What stays in ODIN LINK for now (declarations, cases and invoices come with phases 2–4). */
      for (const [t, where] of [['declarations', ''], ['cases', ''], ['invoices', ''], ['notes', ''], ['users', ''],
        ['attachments', `WHERE rt_id IS NULL${L.has('attachments') && L.cols('attachments').has('product_id') ? ' AND product_id IS NULL' : ''}`]] as const) {
        const n = L.count(t, where); if (n) report.notMoved[t === 'attachments' ? 'attachments (deklarasjoner og saker)' : t] = n;
      }

      await audit(null, { action: 'ODIN_LINK_IMPORT', objectType: 'SYSTEM', objectId: 'ODIN_LINK', detail: { moved: report.moved, skipped: report.skipped, warnings: report.warnings.length } }, c);
      if (!opts.commit) throw new DryRun(report);
    });
    // Files are copied only after the database commit; content-addressed, so a re-run never duplicates them.
    for (const f of pendingFiles) if (!fs.existsSync(f.to)) { fs.mkdirSync(path.dirname(f.to), { recursive: true }); fs.copyFileSync(f.from, f.to); }
    return report;
  } catch (e) {
    if (e instanceof DryRun) return e.report;
    throw e;
  } finally {
    L.close();
  }
}

/** Plain-text report for the command line. */
export function formatReport(r: LinkReport) {
  const lines = [r.dryRun ? 'PRØVEKJØRING – ingenting er lagret. Kjør med --commit for å flytte dataene.' : 'Flyttingen er fullført.', ''];
  const names: Record<string, string> = { partners: 'Forretningspartnere', addresses: 'Adresser', identifiers: 'Identifikatorer', roles: 'Roller', contacts: 'Kontakter',
    registry: 'Brønnøysund-data', creditAccounts: 'Tollkreditt-/dagsoppgjørskontoer', priceItems: 'Prislisteposter (endret pris)', products: 'Produkter',
    productIdentifiers: 'Produktidentifikatorer', productHistory: 'Produkthistorikk', rtPermits: 'RT-tillatelser', documents: 'Dokumenter (vedtaksbrev m.m.)' };
  lines.push('Flyttet:');
  for (const [k, n] of Object.entries(r.moved)) lines.push(`  ${(names[k] ?? k).padEnd(36)} ${n}`);
  if (Object.keys(r.skipped).length) { lines.push('', 'Allerede flyttet (hoppet over):'); for (const [k, n] of Object.entries(r.skipped)) lines.push(`  ${(names[k] ?? k).padEnd(36)} ${n}`); }
  if (r.warnings.length) { lines.push('', `Å kontrollere (${r.warnings.length}):`); for (const w of r.warnings) lines.push('  • ' + w); }
  if (Object.keys(r.notMoved).length) { lines.push('', 'Blir igjen i ODIN LINK foreløpig:'); for (const [k, n] of Object.entries(r.notMoved)) lines.push(`  ${k.padEnd(36)} ${n}`); }
  return lines.join('\n');
}
