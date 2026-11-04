import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { permitStatus } from '../src/products/rt.js';
import { match, expireCheck } from '../src/products/repo.js';
import { client, freshDb, PW } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  await freshDb();
  // A loaded tariff (more than 1,000 declarable codes) so "not in the tariff" can be tested; 1905 31 00 carries RT100.
  await pool.query(`INSERT INTO tariff (code, display, level, text) SELECT lpad(g::text, 8, '0'), lpad(g::text, 8, '0'), 'Code', 'test' FROM generate_series(10000000, 10001100) g`);
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('19053100', '1905 31 00', 'Code', 'Søte kjeks'), ('21039099', '2103 90 99', 'Code', 'ellers')`);
  await pool.query(`INSERT INTO tariff_rate (code, landgruppe, duty_code, rate_value, rate_unit, valid_from) VALUES ('19053100', 'TALL', 'RT100', 6.80, 'SPECIFIC', '2020-01-01')`);
});
afterAll(() => pool.end());

describe('RT permit status on a date', () => {
  it('valid, expiring within 60 days, expired, not yet valid, withdrawn', () => {
    expect(permitStatus({ valid_from: '2026-01-01', valid_to: '2030-01-01' }, '2026-11-04')).toBe('VALID');
    expect(permitStatus({ valid_from: '2026-01-01', valid_to: '2026-12-01' }, '2026-11-04')).toBe('EXPIRING');
    expect(permitStatus({ valid_from: '2023-01-01', valid_to: '2026-09-30' }, '2026-11-04')).toBe('EXPIRED');
    expect(permitStatus({ valid_from: '2027-01-01', valid_to: '2030-01-01' }, '2026-11-04')).toBe('NOT_YET_VALID');
    expect(permitStatus({ valid_from: '2026-01-01', valid_to: '2030-01-01', active: false })).toBe('INACTIVE');
  });
});

describe('products and RT permits', () => {
  const c = client(), view = client();
  let client1 = '', client2 = '', supplier = '', prod = '', other = '', permit = '';
  it('setup: a client, another client, a supplier', async () => {
    await c.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    const u = await c.post('/admin/users', { name: 'Vera', email: 'vera@odin.test', roles: ['viewer'] });
    await view.post('/auth/login', { email: 'vera@odin.test', password: u.body.temporaryPassword });
    await view.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    const mk = async (name: string, org?: string) => {
      const p = (await c.post('/partners', { legal_name: name, registration_country: 'NO' })).body.partner;
      if (org) await c.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      return p.id as string;
    };
    client1 = await mk('Nordlys Matimport AS', '923609016');
    client2 = await mk('Fjordkaffe AS', '931481274');
    supplier = await mk('Euro Food Trading GmbH');
  });
  it('create: code normalised, identifiers per owner, GTIN global, duplicates refused', async () => {
    const r = await c.post('/products', { name: 'Smørkjeks 200 g', owner_id: client1, supplier_id: supplier, code: '1905.31.00', origin: 'de',
      identifiers: [{ type: 'CLIENT_ART', value: 'nm-4410' }, { type: 'SUPPLIER_ART', value: 'EFT-41022' }, { type: 'GTIN', value: '7031234441008' }] });
    expect(r.status).toBe(200);
    const p = r.body.product; prod = p.id;
    expect(p).toMatchObject({ product_no: expect.stringMatching(/^PRD-\d{5}$/), code: '19053100', codeDisplay: '1905 31 00', origin: 'DE', status: 'DRAFT', rtRequired: true });
    expect(p.identifiers.map((i: any) => [i.type, i.norm, i.partner_id])).toEqual([['CLIENT_ART', 'NM4410', client1], ['GTIN', '7031234441008', null], ['SUPPLIER_ART', 'EFT41022', supplier]]);
    expect((await c.post('/products', { name: 'Kopi', owner_id: client1, identifiers: [{ type: 'GTIN', value: '7031234441008' }] })).body.code).toBe('IDENTIFIER_TAKEN');
    const o = await c.post('/products', { name: 'Kjeks hos annen klient', owner_id: client2, identifiers: [{ type: 'CLIENT_ART', value: 'NM-4410' }] });
    expect(o.status).toBe(200);    // the same article number at another client is a different number
    other = o.body.product.id;
    expect((await c.post('/products', { name: 'x', code: '1905' })).body.code).toBe('CODE_FORMAT');
    expect((await view.post('/products', { name: 'Nope' })).status).toBe(403);
  });
  it('matching an invoice line: GTIN, then client article no., then supplier article no.; never another client\'s product', async () => {
    expect((await match({ gtin: '7031234441008', ownerId: client1 }))!.by).toBe('GTIN');
    expect((await match({ clientArt: 'NM 4410', ownerId: client1 }))!.product.id).toBe(prod);
    expect((await match({ clientArt: 'NM-4410', ownerId: client2 }))!.product.id).toBe(other);
    expect((await match({ supplierArt: 'eft-41022', ownerId: client1, supplierId: supplier }))!.product.id).toBe(prod);
    expect(await match({ gtin: '7031234441008', ownerId: client2 })).toBeNull();
  });
  it('status: CHECKED needs a code in the tariff and a basis (BKU number for BKU); BLOCKED needs a reason', async () => {
    expect((await c.post(`/products/${prod}/status`, { status: 'CHECKED' })).body.code).toBe('CHECK_NO_BASIS');
    expect((await c.post(`/products/${prod}/status`, { status: 'CHECKED', basis: 'BKU' })).body.code).toBe('CHECK_NO_BKU');
    const ok = await c.post(`/products/${prod}/status`, { status: 'CHECKED', basis: 'BKU', reference_no: 'BKU 2024/1182' });
    expect(ok.body.product).toMatchObject({ status: 'CHECKED', basis: 'BKU', reference_no: 'BKU 2024/1182' });
    expect(ok.body.product.checked_at).toBeTruthy();
    expect((await c.post(`/products/${other}/status`, { status: 'BLOCKED' })).body.code).toBe('BLOCK_REASON');
    await c.put(`/products/${other}`, { code: '99999999', change_basis: 'test' });
    expect((await c.post(`/products/${other}/status`, { status: 'CHECKED', basis: 'OTHER' })).body.code).toBe('CHECK_NOT_IN_TARIFF');
  });
  it('a code change needs a basis and sends a checked product back to review; history kept', async () => {
    const p = (await c.get(`/products/${prod}`)).body;
    expect((await c.put(`/products/${prod}`, { code: '21039099', version: p.version })).body.code).toBe('BASIS_REQUIRED');
    const r = await c.put(`/products/${prod}`, { code: '2103 90 99', change_basis: 'Ny BKU 2026/77', version: p.version });
    expect(r.body.product.status).toBe('REVIEW');
    expect(r.body.warnings[0].msg).toMatch(/kontrolleres på nytt/);
    const h = r.body.product.history.map((x: any) => [x.field, x.old_value, x.new_value, x.basis]);
    expect(h).toContainEqual(['code', '19053100', '21039099', 'Ny BKU 2026/77']);
    expect(h).toContainEqual(['status', 'CHECKED', 'REVIEW', 'Varenummer endret']);
    expect((await c.put(`/products/${prod}`, { name: 'x', version: p.version })).body.code).toBe('VERSION');
    await c.put(`/products/${prod}`, { code: '19053100', change_basis: 'Tilbake', version: r.body.product.version });
  });
  it('RT permit from the product card: holder = client, org. no. from the partner card, both variants', async () => {
    const r = await c.post('/rt-permits', { product_id: prod, case_ref: '24/01882', skriv_tall: '4410113', rate_tall: '3,12', skriv_toes: '4410114', rate_toes: '1,85',
      valid_from: '2024-03-01', valid_to: plus(30) });
    expect(r.status).toBe(200);
    permit = r.body.permit.id;
    expect(r.body.permit).toMatchObject({ holder_id: client1, holder_org_no: '923609016', holder_name: 'Nordlys Matimport AS', product_name: 'Smørkjeks 200 g',
      tariff_code: '19053100', rate_tall: '3.1200', rate_toes: '1.8500', status: 'EXPIRING', permit_no: expect.stringMatching(/^RT-\d{5}$/) });
    expect(r.body.warnings).toEqual([]);
    expect((await c.post('/rt-permits', { product_id: prod, valid_from: '2026-01-01', valid_to: '2025-01-01', rate_tall: 1 })).body.code).toBe('RT_DATES');
    expect((await c.post('/rt-permits', { product_id: prod, valid_from: '2026-01-01', valid_to: '2027-01-01' })).body.code).toBe('RT_NO_RATE');
  });
  it('checks are shown: holder not the client, other org. no. in the letter, other code, overlap', async () => {
    const r = await c.post('/rt-permits', { product_id: prod, holder_id: client2, holder_org_no: '999999999', tariff_code: '21039099', rate_tall: 4, valid_from: today, valid_to: plus(400) });
    const codes = r.body.warnings.map((w: any) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['RT_HOLDER_ORG_DIFFERS', 'RT_HOLDER_NOT_OWNER', 'RT_CODE_DIFFERS', 'RT_OVERLAP']));
    const w = await c.post(`/rt-permits/${r.body.permit.id}/withdraw`, {});
    expect(w.body.code).toBe('RT_REASON');
    expect((await c.post(`/rt-permits/${r.body.permit.id}/withdraw`, { reason: 'Registrert ved en feil' })).body.permit.status).toBe('INACTIVE');
  });
  it('renewal starts the day after the current permit ends, prefilled; the product keeps both as history', async () => {
    const d = (await c.get(`/products/${prod}/rt-renewal`)).body;
    expect(d).toMatchObject({ holder_id: client1, rate_tall: '3.1200', valid_from: plus(31) });
    const n = await c.post('/rt-permits', { ...d, case_ref: '26/09001', rate_tall: '3,05' });
    expect(n.body.warnings).toEqual([]);
    const card = (await c.get(`/products/${prod}`)).body;
    expect(card.rtPermits.filter((x: any) => x.status !== 'INACTIVE').map((x: any) => x.status)).toEqual(['NOT_YET_VALID', 'EXPIRING']);
  });
  it('the client card shows its permits and its RT products without a valid permit', async () => {
    const rtProd = (await c.post('/products', { name: 'Sjokoladekjeks', owner_id: client1, code: '19053100' })).body.product;
    const r = (await c.get(`/partners/${client1}/rt-permits`)).body;
    expect(r.permits.length).toBeGreaterThanOrEqual(2);
    expect(r.missing.map((p: any) => p.id)).toEqual([rtProd.id]);
    expect((await c.get('/products?rt=missing')).body.map((p: any) => p.id)).toEqual([rtProd.id]);
    expect((await c.get(`/partners/${client1}/products`)).body.length).toBe(2);
  });
  it('a permit without a product: create the product from it, linked', async () => {
    await pool.query(`INSERT INTO rt_permit (holder_id, holder_org_no, product_name, tariff_code, rate_tall, valid_from, valid_to, sku)
      VALUES ($1, '923609016', 'Pastasaus 400 g', '21039099', 2.1, '2025-01-01', '2028-01-01', 'NM-6230')`, [client1]);
    const unlinked = (await c.get('/rt-permits?unlinked=1')).body;
    expect(unlinked).toHaveLength(1);
    const r = await c.post(`/rt-permits/${unlinked[0].id}/create-product`);
    expect(r.body.product).toMatchObject({ name: 'Pastasaus 400 g', code: '21039099', owner_id: client1, created_from: 'RT' });
    expect(r.body.product.identifiers[0]).toMatchObject({ type: 'CLIENT_ART', norm: 'NM6230' });
    expect(r.body.permit.product_id).toBe(r.body.product.id);
  });
  it('documents: a decision letter on the permit and a BKU on the product, stored once by checksum', async () => {
    const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
    const a = await c.post(`/rt-permits/${permit}/documents`, { filename: 'Vedtak_24-01882.pdf', mime: 'application/pdf', contentBase64: pdf });
    expect(a.body.permit.documents[0]).toMatchObject({ filename: 'Vedtak_24-01882.pdf', doc_code: 'RT01' });
    const b = await c.post(`/products/${prod}/documents`, { filename: 'BKU.pdf', mime: 'application/pdf', contentBase64: pdf, docCode: 'BKU' });
    const id = b.body.product.documents[0].id;
    const dl = await c.get(`/documents/${id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect((await c.post(`/products/${prod}/documents`, { filename: 'x.exe', mime: 'application/x-msdownload', contentBase64: pdf })).status).toBe(415);
    expect((await pool.query('SELECT COUNT(DISTINCT storage_path) n FROM document')).rows[0].n).toBe(1);
    await c.post(`/documents/${id}/remove`);
    expect((await c.get(`/products/${prod}`)).body.documents).toHaveLength(0);
  });
  it('merge moves identifiers, history and RT permits; the duplicate stays as a trace', async () => {
    const dup = (await c.post('/products', { name: 'Smørkjeks (dublett)', owner_id: client1, identifiers: [{ type: 'GTIN', value: '7031234441015' }] })).body.product;
    const m = await c.post(`/products/${dup.id}/merge`, { target: prod });
    expect(m.body.product.identifiers.some((i: any) => i.norm === '7031234441015')).toBe(true);
    const gone = (await c.get(`/products/${dup.id}`)).body;
    expect(gone).toMatchObject({ active: false, mergedIntoNo: m.body.product.product_no });
    expect((await c.put(`/products/${dup.id}`, { name: 'x' })).body.code).toBe('MERGED');
  });
  it('partner merge moves products, permits and article numbers to the partner kept', async () => {
    const dupClient = (await c.post('/partners', { legal_name: 'Nordlys (gammel)', registration_country: 'NO' })).body.partner.id;
    const p = (await c.post('/products', { name: 'Flatbrød', owner_id: dupClient, identifiers: [{ type: 'CLIENT_ART', value: 'FB-1' }] })).body.product;
    await c.post('/rt-permits', { product_id: p.id, rate_tall: 1, valid_from: today, valid_to: plus(100) });
    const r = await c.post(`/partners/${dupClient}/merge`, { target: client1 });
    expect(r.body.moved).toMatchObject({ products: 1, rtPermits: 1, articleNumbers: 1 });
    expect((await c.get(`/products/${p.id}`)).body.owner_id).toBe(client1);
    expect((await match({ clientArt: 'FB-1', ownerId: client1 }))!.product.id).toBe(p.id);
  });
  it('daily expiry: valid-to passed or code gone from the tariff', async () => {
    const p = (await c.post('/products', { name: 'Utløpt', owner_id: client1, code: '19053100', valid_to: '2020-01-01' })).body.product;
    const q = (await c.post('/products', { name: 'Kode borte', owner_id: client1, code: '10000005' })).body.product;
    await pool.query("DELETE FROM tariff WHERE code = '10000005'");
    expect(await expireCheck()).toBeGreaterThanOrEqual(2);
    expect((await c.get(`/products/${p.id}`)).body).toMatchObject({ status: 'EXPIRED', status_reason: 'VALID_TO 2020-01-01' });
    expect((await c.get(`/products/${q.id}`)).body.status_reason).toMatch(/^TARIFF/);
    expect((await c.get('/products/worklists')).body.tariffChange.map((x: any) => x.id)).toContain(q.id);
  });
  it('every change is in the audit log for the product', async () => {
    const log = (await c.get(`/admin/audit?objectType=PRODUCT&objectId=${prod}&limit=200`)).body as any[];
    for (const a of ['PRODUCT_CREATED', 'PRODUCT_STATUS', 'PRODUCT_CODE_CHANGED', 'RT_PERMIT_CREATED', 'DOCUMENT_STORED', 'DOCUMENT_REMOVED', 'PRODUCT_MERGED'])
      expect(log.map(r => r.action)).toContain(a);
  });
});
