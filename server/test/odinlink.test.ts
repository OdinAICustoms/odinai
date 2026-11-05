import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pool } from '../src/db.js';
import { freshDb } from './helpers.js';
import { importOdinLink } from '../src/legacy/odinlink.js';

/** A small ODIN LINK 2.37 database with the tables the move reads. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odinlink-test-'));
const dbPath = path.join(dir, 'odin-link.db');
const filesDir = path.join(dir, 'files');
const fileStore = path.join(dir, 'store');
const letter = Buffer.from('%PDF-1.4 vedtaksbrev');
const sha = crypto.createHash('sha256').update(letter).digest('hex');

function buildLink() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT);
    CREATE TABLE business_partners (id TEXT PRIMARY KEY, partner_no TEXT, category TEXT, legal_name TEXT, search_name TEXT, registration_country TEXT, language TEXT,
      is_client INTEGER, notes TEXT, source_system TEXT, legacy_operator_id TEXT, status TEXT, merged_into TEXT, created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
      version INTEGER, deposit_paid INTEGER, deposit_amount REAL, deposit_date TEXT);
    CREATE TABLE business_partner_addresses (id TEXT, partner_id TEXT, address_type TEXT, address_name TEXT, street TEXT, postal_code TEXT, city TEXT, region TEXT, country_code TEXT,
      location_code TEXT, is_standard INTEGER, valid_from TEXT, valid_to TEXT, status TEXT);
    CREATE TABLE business_partner_identifiers (id TEXT, partner_id TEXT, identifier_type TEXT, identifier_value TEXT, issuing_country TEXT, valid_from TEXT, valid_to TEXT,
      is_primary INTEGER, source TEXT, check_status TEXT, check_name TEXT, check_address TEXT, checked_at TEXT, check_error TEXT);
    CREATE TABLE business_partner_roles (id TEXT, partner_id TEXT, role_code TEXT, valid_from TEXT, valid_to TEXT, status TEXT, notes TEXT);
    CREATE TABLE business_partner_contacts (id TEXT, partner_id TEXT, contact_type TEXT, contact_name TEXT, department TEXT, email TEXT, telephone TEXT, is_primary INTEGER, status TEXT, notify_clearance INTEGER);
    CREATE TABLE business_partner_registry (partner_id TEXT, source TEXT, org_no TEXT, vat_registered INTEGER, bankrupt INTEGER, winding_up INTEGER, forced_dissolution INTEGER,
      deleted INTEGER, data TEXT, roles TEXT, fetched_at TEXT, fetch_error TEXT);
    CREATE TABLE business_partner_fullmakt (id TEXT);
    CREATE TABLE credit_agreements (account TEXT, holder TEXT, role TEXT, org_no TEXT, active INTEGER, valid_to TEXT, payment_type TEXT, partner_id TEXT);
    CREATE TABLE price_items (code TEXT, name_no TEXT, unit TEXT, price REAL, free_lines INTEGER);
    CREATE TABLE products (id TEXT, owner_id TEXT, gtin TEXT, sku TEXT, name TEXT, descr TEXT, code TEXT, origin TEXT, net TEXT, gross TEXT, supp TEXT, price REAL, currency TEXT,
      active INTEGER, updated_at TEXT, product_no TEXT, supplier_id TEXT, status TEXT, basis TEXT, reference_no TEXT, checked_by TEXT, checked_at TEXT, valid_to TEXT,
      pref_basis TEXT, notes TEXT, status_reason TEXT, merged_into TEXT, created_at TEXT, created_from TEXT);
    CREATE TABLE product_history (id INTEGER PRIMARY KEY, product_id TEXT, field TEXT, old_value TEXT, new_value TEXT, basis TEXT, user_id TEXT, at TEXT);
    CREATE TABLE rt_permits (id TEXT, sku TEXT, gtin TEXT, product_name TEXT, tariff_code TEXT, ref_internal TEXT, case_ref TEXT, skriv_tall TEXT, rate_tall REAL, skriv_toes TEXT,
      rate_toes REAL, rate_unit TEXT, duty_code TEXT, valid_from TEXT, valid_to TEXT, document_path TEXT, active INTEGER, created_at TEXT, updated_at TEXT,
      holder_org_no TEXT, holder_name TEXT, holder_partner_id TEXT, product_id TEXT);
    CREATE TABLE attachments (id TEXT, decl_id TEXT, rt_id TEXT, doc_code TEXT, filename TEXT, mime TEXT, size_bytes INTEGER, sha256 TEXT, storage_path TEXT, uploaded_by TEXT,
      created_at TEXT, product_id TEXT, case_id TEXT, case_item_id TEXT);
    CREATE TABLE declarations (id TEXT);
  `);
  const ins = (t: string, o: Record<string, unknown>) => db.prepare(`INSERT INTO ${t} (${Object.keys(o).join(',')}) VALUES (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o));
  ins('users', { id: 'u1', email: 'ADA@odin.test', name: 'Ada' });
  ins('business_partners', { id: 'o5', partner_no: 'BP-00005', category: 'ORGANIZATION', legal_name: 'Desi Hub AS', registration_country: 'NO', language: 'NO', is_client: 1,
    status: 'ACTIVE', legacy_operator_id: 'op-77', created_at: '2026-09-26 22:22:04', created_by: 'u1', updated_at: '2026-09-27 13:10:39', deposit_paid: 1, deposit_amount: 5000, deposit_date: '2026-09-01' });
  ins('business_partners', { id: 'x8', partner_no: 'BP-00008', category: 'ORGANIZATION', legal_name: 'Imran & Sons', registration_country: 'pk', is_client: 1, status: 'ACTIVE' });
  ins('business_partner_addresses', { id: 'a1', partner_id: 'o5', address_type: 'REGISTERED', street: 'Oscars gate 27', postal_code: '0352', city: 'OSLO', country_code: 'NO', is_standard: 1, status: 'ACTIVE' });
  ins('business_partner_addresses', { id: 'a2', partner_id: 'o5', address_type: 'REGISTERED', street: 'Norge', country_code: 'NO', valid_to: '2026-09-26', status: 'ENDED' });
  ins('business_partner_identifiers', { id: 'i1', partner_id: 'o5', identifier_type: 'ORG_NO', identifier_value: '933154823', issuing_country: 'NO', is_primary: 1 });
  ins('business_partner_roles', { id: 'r1', partner_id: 'o5', role_code: 'IMP', status: 'ACTIVE' });
  ins('business_partner_contacts', { id: 'c1', partner_id: 'o5', contact_type: 'CUSTOMS', email: 'toll@desihub.no', is_primary: 1, status: 'ACTIVE', notify_clearance: 1 });
  ins('business_partner_registry', { partner_id: 'o5', source: 'BRREG', org_no: '933154823', vat_registered: 1, bankrupt: 0, winding_up: 0, forced_dissolution: 0, deleted: 0,
    data: JSON.stringify({ name: 'DESI HUB AS' }), roles: JSON.stringify({ chair: ['A. Person'] }), fetched_at: '2026-10-08 21:09:56' });
  ins('credit_agreements', { account: '123456', holder: 'op-77', role: 'declarant', active: 1, payment_type: 'DAGSOPPGJOR' });
  ins('credit_agreements', { account: 'DAGSOPPGJØR', holder: 'x8', role: 'representative', active: 1, payment_type: 'DAGSOPPGJOR' });
  ins('credit_agreements', { account: '999', holder: 'gone', role: 'declarant', active: 1, payment_type: 'TOLLKREDITT' });
  ins('price_items', { code: 'DECL_IMP', name_no: 'Fortolling innførsel', unit: 'PER_DECL', price: 450 });
  ins('products', { id: 'p1', product_no: 'PRD-00003', owner_id: 'op-77', name: 'Methi', descr: 'Tørket bukkehornkløver', code: '0709 99 90', origin: 'in', net: '0,5', sku: 'MT-1',
    gtin: '7040110569900', status: 'CHECKED', basis: 'BKU', reference_no: 'BKU 1', checked_by: 'u1', checked_at: '2026-10-17 13:17:17', created_at: '2026-10-17 13:17:17' });
  ins('products', { id: 'p2', product_no: 'PRD-00004', name: 'Chana', descr: 'Chana', code: '2109098', status: 'CHECKED' });
  ins('product_history', { product_id: 'p1', field: 'created', new_value: 'MANUAL', user_id: 'u1', at: '2026-10-17 13:17:17' });
  ins('rt_permits', { id: 'rt1', product_name: 'Roasted Moong Dal', tariff_code: '21069098', skriv_tall: '26/R844041', rate_tall: 0, skriv_toes: '26/R844040', rate_toes: 0,
    valid_from: '2026-09-24', valid_to: '2029-09-24', active: 1, holder_org_no: '933154823', holder_name: 'DESIHUB', holder_partner_id: 'o5', created_at: '2026-09-30 13:12:33' });
  ins('rt_permits', { id: 'rt2', product_name: 'Chana Jor Garanm', tariff_code: '2109098', rate_tall: 1.5, valid_from: '2026-09-24', valid_to: '2029-09-24', active: 1,
    holder_partner_id: 'o5', product_id: 'p2' });
  ins('rt_permits', { id: 'rt3', product_name: 'Bad dates', tariff_code: '19059093', rate_tall: 1, valid_from: '2027-01-01', valid_to: '2026-01-01', active: 1 });
  ins('attachments', { id: 'f1', rt_id: 'rt1', doc_code: 'RT01', filename: 'vedtak.pdf', mime: 'application/pdf', size_bytes: letter.length, sha256: sha,
    storage_path: `${sha.slice(0, 2)}\\${sha.slice(2, 4)}\\${sha}`, uploaded_by: 'u1', created_at: '2026-09-30 13:20:00' });
  ins('attachments', { id: 'f2', decl_id: 'd1', doc_code: 'N380', filename: 'faktura.pdf', sha256: 'x', storage_path: 'x' });
  ins('declarations', { id: 'd1' });
  db.close();
  fs.mkdirSync(path.join(filesDir, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true });
  fs.writeFileSync(path.join(filesDir, sha.slice(0, 2), sha.slice(2, 4), sha), letter);
}

const count = async (t: string) => (await pool.query(`SELECT count(*) n FROM ${t}`)).rows[0].n;

describe('move from ODIN LINK', () => {
  beforeAll(async () => {
    await freshDb();
    await pool.query("INSERT INTO users (email, name, password_hash, roles) VALUES ('ada@odin.test', 'Ada', 'x', '{admin}')");
    buildLink();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('dry run reports everything and saves nothing', async () => {
    const r = await importOdinLink({ dbPath, filesDir, fileStore });
    expect(r.dryRun).toBe(true);
    expect(r.moved).toMatchObject({ partners: 2, addresses: 2, identifiers: 1, roles: 1, contacts: 1, registry: 1, creditAccounts: 2, products: 2, rtPermits: 2, documents: 1, priceItems: 1 });
    expect(await count('business_partner')).toBe(0);
    expect(await count('audit_log')).toBe(0);
    expect(fs.existsSync(fileStore)).toBe(false);
  });

  it('moves partners with their numbers, children, registry and credit accounts', async () => {
    const r = await importOdinLink({ dbPath, filesDir, fileStore, commit: true });
    expect(r.dryRun).toBe(false);
    const p = (await pool.query("SELECT * FROM business_partner WHERE partner_no = 'BP-00005'")).rows[0];
    expect(p).toMatchObject({ legal_name: 'Desi Hub AS', search_name: 'DESI HUB AS', source: 'ODIN_LINK', legacy_id: 'o5', is_client: true, deposit_paid: true, deposit_date: '2026-09-01' });
    expect(p.created_by).not.toBeNull();                          // matched on e-mail, case-insensitive
    expect((await pool.query("SELECT registration_country FROM business_partner WHERE partner_no = 'BP-00008'")).rows[0].registration_country).toBe('PK');
    expect((await pool.query('SELECT status FROM bp_address WHERE partner_id = $1 ORDER BY status', [p.id])).rows.map(x => x.status)).toEqual(['ACTIVE', 'ENDED']);
    expect((await pool.query('SELECT clearance_mail FROM bp_contact WHERE partner_id = $1', [p.id])).rows[0].clearance_mail).toBe(true);
    expect((await pool.query('SELECT roles FROM bp_registry WHERE partner_id = $1', [p.id])).rows[0].roles).toEqual({ chair: ['A. Person'] });
    const credit = (await pool.query('SELECT c.account, b.partner_no FROM bp_credit_account c JOIN business_partner b ON b.id = c.partner_id ORDER BY account')).rows;
    expect(credit).toEqual([{ account: '123456', partner_no: 'BP-00005' }, { account: 'DAGSOPPGJØR', partner_no: 'BP-00008' }]);   // holder via operator id
    expect(r.warnings.some(w => w.includes('«DAGSOPPGJØR» er ikke et kontonummer'))).toBe(true);
    expect(r.warnings.some(w => w.includes('Kredittkonto 999'))).toBe(true);
    expect((await pool.query("SELECT price FROM price_item WHERE code = 'DECL_IMP'")).rows[0].price).toBe('450.00');
    // The next new partner continues after the moved numbers.
    expect((await pool.query("INSERT INTO business_partner (legal_name, search_name) VALUES ('Ny', 'NY') RETURNING partner_no")).rows[0].partner_no).toBe('BP-00009');
  });

  it('moves products and flags what OdinAi cannot accept', async () => {
    const r = await importOdinLink({ dbPath, filesDir, fileStore });   // dry run on top: everything already there
    expect(r.moved.products ?? 0).toBe(0);
    const p1 = (await pool.query("SELECT p.*, b.partner_no owner_no FROM product p LEFT JOIN business_partner b ON b.id = p.owner_id WHERE product_no = 'PRD-00003'")).rows[0];
    expect(p1).toMatchObject({ owner_no: 'BP-00005', code: '07099990', origin: 'IN', net_kg: '0.500', status: 'CHECKED', basis: 'BKU', created_from: 'ODIN_LINK' });
    const ids = (await pool.query('SELECT type, norm, partner_id FROM product_identifier WHERE product_id = $1 ORDER BY type', [p1.id])).rows;
    expect(ids.map(i => [i.type, i.norm])).toEqual([['CLIENT_ART', 'MT1'], ['GTIN', '7040110569900']]);
    expect(ids[0].partner_id).toBe(p1.owner_id);
    expect(await count('product_history')).toBe(1);
    const p2 = (await pool.query("SELECT code, status, notes FROM product WHERE product_no = 'PRD-00004'")).rows[0];
    expect(p2).toMatchObject({ code: null, status: 'REVIEW' });
    expect(p2.notes).toContain('2109098');
  });

  it('moves RT permits and their decision letters', async () => {
    const rts = (await pool.query('SELECT r.*, p.product_no FROM rt_permit r LEFT JOIN product p ON p.id = r.product_id ORDER BY r.product_name DESC')).rows;
    expect(rts).toHaveLength(2);                                    // the one with impossible dates is left out
    expect(rts[0]).toMatchObject({ product_name: 'Roasted Moong Dal', tariff_code: '21069098', rate_tall: '0.0000', holder_org_no: '933154823', product_id: null });
    expect(rts[1]).toMatchObject({ product_name: 'Chana Jor Garanm', product_no: 'PRD-00004', tariff_code: null });
    expect(rts[1].notes).toContain('2109098');
    const doc = (await pool.query("SELECT * FROM document WHERE owner_type = 'RT_PERMIT'")).rows[0];
    expect(doc).toMatchObject({ owner_id: rts[0].id, doc_code: 'RT01', filename: 'vedtak.pdf', sha256: sha });
    expect(fs.readFileSync(path.join(fileStore, doc.storage_path)).equals(letter)).toBe(true);
  });

  it('a second run moves nothing twice and reports what stays behind', async () => {
    const r = await importOdinLink({ dbPath, filesDir, fileStore, commit: true });
    expect(r.moved.partners ?? 0).toBe(0);
    expect(r.skipped).toMatchObject({ partners: 2, products: 2, rtPermits: 2, creditAccounts: 2, documents: 1 });
    expect(await count('bp_address')).toBe(2);
    expect(await count('document')).toBe(1);
    expect(r.notMoved).toMatchObject({ declarations: 1, users: 1, 'attachments (deklarasjoner og saker)': 1 });
    expect(r.notMoved).not.toHaveProperty('business_partner_fullmakt');   // empty tables are not listed
    const a = (await pool.query("SELECT count(*) n FROM audit_log WHERE action IN ('PARTNER_IMPORTED','PRODUCT_IMPORTED','RT_IMPORTED')")).rows[0].n;
    expect(a).toBe(6);
  });
});
