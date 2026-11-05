import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { setProvider, type Extraction, type Provider } from '../src/ai/provider.js';
import { client, freshDb, PW } from './helpers.js';

/** A fake AI: returns a fixed extraction, so nothing is ever sent to the AI service from the tests. */
const party = (o: Partial<Extraction['supplier']>) => ({ name: null, street: null, postal_code: null, city: null, country: null, org_no: null, vat_no: null, eori: null, ...o });
const line = (o: Partial<Extraction['lines'][number]>) => ({ article_no: null, gtin: null, description: 'x', quantity: null, unit: null, unit_price: null, line_total: null,
  gross_kg: null, net_kg: null, packages: null, origin: null, hs_code: null, confidence: 0.95, document_index: 1, page: 1, ...o });
const EXTRACTION: Extraction = {
  documents: [{ index: 1, kind: 'INVOICE', number: 'INV-7781', date: '2026-10-30' }, { index: 2, kind: 'PACKING_LIST', number: null, date: null }],
  supplier: party({ name: 'Euro-Food Trading GmbH', country: 'DE', city: 'Hamburg' }),
  buyer: party({ name: 'Nordlys Matimport', org_no: '923 609 016' }),
  invoice_no: 'INV-7781', invoice_date: '2026-10-30', currency: 'eur', incoterms: 'DAP Oslo', incoterms_place: 'Oslo', invoice_total: 1300,
  freight: 50, insurance: null, discount: null, total_gross_kg: 130, total_net_kg: 120, packages: 12, package_kind: 'CT',
  dispatch_country: 'DE', origin_country: null, transport_mode: 'ROAD', transport_identity: 'HH-AB 123', transport_nationality: 'DE', container_numbers: null,
  export_declaration_ref: '26DE0000000123456', transit_ref: null, ched_ref: null,
  lines: [
    line({ article_no: 'nm-4410', description: 'MANGO CHUTNEY 6x1kg', quantity: 10, unit_price: 100, line_total: 1000, gross_kg: 66, net_kg: 60, packages: 10, origin: 'IN', hs_code: '20019099' }),
    line({ article_no: 'X-9', description: 'Butter biscuits', quantity: 2, unit_price: 125, gross_kg: 64, net_kg: 60, packages: 2, origin: 'DE', hs_code: '1905.31.00', confidence: 0.6 }),
    line({ article_no: 'Z-1', description: 'Sample (not delivered)' })
  ],
  remarks: ['The packing list shows 12 cartons; the invoice does not state packages.']
};
let next: () => Promise<{ data: Extraction; model: string; usage: null }> = async () => ({ data: EXTRACTION, model: 'fake-model', usage: null });
let configured = true;
const fake: Provider = { configured: () => configured, model: () => 'fake-model', extract: () => next() };
const PDF = Buffer.from('%PDF-1.4 fake invoice').toString('base64');

beforeAll(async () => {
  await freshDb();
  setProvider(fake);
  await pool.query(`INSERT INTO tariff (code, display, level, text) SELECT lpad(g::text, 8, '0'), lpad(g::text, 8, '0'), 'Code', 'test' FROM generate_series(10000000, 10001100) g`);
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('21039099', '2103 90 99', 'Code', 'ellers'), ('19053100', '1905 31 00', 'Code', 'kjeks')`);
});
afterAll(async () => { setProvider(null); await pool.end(); });

const waitDone = async (c: ReturnType<typeof client>, id: string) => {
  for (let i = 0; i < 50; i++) {
    const d = (await c.get(`/declarations/${id}`)).body;
    if (d.intakes[0] && ['DONE', 'FAILED'].includes(d.intakes[0].status)) return d;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('intake did not finish');
};

describe('AI intake', () => {
  const sara = client();
  let importer = '', exporter = '', product = '';
  it('setup: an importer, an exporter, a checked product with the client\'s article number', async () => {
    const admin = client();
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    const u = await admin.post('/admin/users', { name: 'Sara', email: 'sara@odin.test', roles: ['specialist'] });
    await sara.post('/auth/login', { email: 'sara@odin.test', password: u.body.temporaryPassword });
    await sara.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    importer = (await sara.post('/partners', { legal_name: 'Nordlys Matimport AS', registration_country: 'NO' })).body.partner.id;
    await sara.post(`/partners/${importer}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: '923609016', is_primary: true });
    exporter = (await sara.post('/partners', { legal_name: 'Euro Food Trading GmbH', registration_country: 'DE' })).body.partner.id;
    const p = await sara.post('/products', { name: 'Mango chutney 6x1 kg', descr: 'Mango chutney i glass', owner_id: importer, code: '21039099', origin: 'IN',
      identifiers: [{ type: 'CLIENT_ART', value: 'NM-4410' }] });
    product = p.body.product.id;
    await sara.post(`/products/${product}/status`, { status: 'CHECKED', basis: 'BKU', reference_no: 'BKU-1' });
    expect((await sara.get('/ai/status')).body).toMatchObject({ configured: true, model: 'fake-model' });
  });

  it('documents in, draft out: parties, header boxes, box 44, box 12 — register first, never guessed', async () => {
    const r = await sara.post('/declarations/ai', { files: [{ filename: 'inv.pdf', mime: 'application/pdf', contentBase64: PDF, docCode: 'N380' },
      { filename: 'pl.pdf', mime: 'application/pdf', contentBase64: PDF, docCode: 'N271' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ created_from: 'AI', status: 'DRAFT' });
    expect(r.body.documents).toHaveLength(2);
    const d = await waitDone(sara, r.body.id);
    expect(d.intakes[0]).toMatchObject({ status: 'DONE', model: 'fake-model', prompt_version: 'odinai-intake-2026-11-v1', documents: 2 });
    expect(d).toMatchObject({ exporter_id: exporter, importer_id: importer, client_id: importer, currency: 'EUR', incoterms: 'DAP', incoterms_place: 'Oslo',
      invoice_total: '1300.00', dispatch_country: 'DE', transport_mode: '3', transport_id: 'HH-AB 123', transport_nat: 'DE', prev_doc: '26DE0000000123456', own_ref: 'INV-7781' });
    expect(d.docs).toEqual([{ code: 'N380', ref: 'INV-7781', date: '2026-10-30' }, { code: 'N271', ref: 'INV-7781' }]);
    expect(d.value_details).toEqual([expect.objectContaining({ kind: 'ADD', type: 'FRAKT', amount: 50, currency: 'INV', basis: 'GROSS' })]);

    // Line 1: the register product (by the client's article number) gives text, code and origin; the invoice code differs and is reported.
    expect(d.items).toHaveLength(2);
    expect(d.items[0]).toMatchObject({ product_id: product, description: 'Mango chutney i glass', code: '21039099', origin: 'IN', price: '1000.00', net_kg: '60.000', packages: 10, procedure: '4000' });
    expect(d.items[0].source).toMatchObject({ fields: { description: 'PRODUCT', code: 'PRODUCT', origin: 'PRODUCT' }, confidence: 0.95, read: { hs_code: '20019099' } });
    // Line 2: no product: invoice text, the printed code only because it is in the tariff, price = quantity × unit price.
    expect(d.items[1]).toMatchObject({ product_id: null, description: 'Butter biscuits', code: '19053100', origin: 'DE', price: '250.00' });
    expect(d.items[1].source.fields).toEqual({ description: 'INVOICE', code: 'INVOICE', origin: 'INVOICE' });

    const kinds = d.reviews.map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['AI_REMARK', 'BOX12', 'CODE_DIFFERS', 'LINE_SKIPPED', 'LOW_CONFIDENCE', 'PRODUCT_UNMATCHED', 'TOTALS']);
    expect(d.reviews.find((x: any) => x.kind === 'TOTALS').msg).toMatch(/1250\.00.*1300\.00/);
    expect(d.issues.map((i: any) => i.rule)).toContain('REVIEW_OPEN');
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE object_id = $1 ORDER BY id`, [d.id])).rows.map(x => x.action);
    expect(actions).toEqual(expect.arrayContaining(['DECLARATION_CREATED', 'DOCUMENT_STORED', 'AI_INTAKE_STARTED', 'AI_INTAKE_DONE']));

    // Review points are cleared one by one, with a note; reopening is possible; all cleared removes the warning.
    let card = d;
    for (const x of d.reviews) card = (await sara.post(`/declarations/${d.id}/reviews/${x.id}/clear`, { note: 'Kontrollert' })).body;
    expect(card.issues.map((i: any) => i.rule)).not.toContain('REVIEW_OPEN');
    card = (await sara.post(`/declarations/${d.id}/reviews/${d.reviews[0].id}/reopen`, {})).body;
    expect(card.reviews.filter((x: any) => x.status === 'OPEN')).toHaveLength(1);

    // The AI fills an empty declaration only; it never rewrites one with goods items.
    expect((await sara.post(`/declarations/${d.id}/ai`, {})).body.code).toBe('HAS_ITEMS');
  });

  it('an unknown supplier becomes a review point, and the partner can be created from what the AI read', async () => {
    next = async () => ({ data: { ...EXTRACTION, supplier: party({ name: 'Spice Route Exports Pvt Ltd', street: '12 Market Rd', city: 'Mumbai', country: 'IN', eori: 'IN1234567890' }) }, model: 'fake-model', usage: null });
    const r = await sara.post('/declarations/ai', { importer_id: importer, files: [{ filename: 'inv.pdf', mime: 'application/pdf', contentBase64: PDF }] });
    const d = await waitDone(sara, r.body.id);
    expect(d.exporter_id).toBeNull();
    const rv = d.reviews.find((x: any) => x.kind === 'PARTY_UNKNOWN');
    expect(rv.msg).toMatch(/Spice Route Exports/);
    const after = (await sara.post(`/declarations/${d.id}/reviews/${rv.id}/create-partner`, {})).body;
    expect(after.parties.exporter.legal_name).toBe('Spice Route Exports Pvt Ltd');
    expect(after.reviews.find((x: any) => x.id === rv.id)).toMatchObject({ status: 'CLEARED', clear_note: expect.stringMatching(/^Opprettet BP-\d{5}$/) });
    const p = (await pool.query(`SELECT b.registration_country, b.source, (SELECT city FROM bp_address WHERE partner_id = b.id) city,
        (SELECT identifier_value FROM bp_identifier WHERE partner_id = b.id AND identifier_type = 'EORI') eori,
        (SELECT role_code FROM bp_role WHERE partner_id = b.id) role FROM business_partner b WHERE b.id = $1`, [after.exporter_id])).rows[0];
    expect(p).toEqual({ registration_country: 'IN', source: 'AI', city: 'Mumbai', eori: 'IN1234567890', role: 'EXP' });
  });

  it('a failed AI call leaves the draft empty with the reason; a client that refused AI is never sent; no key, no AI', async () => {
    next = async () => { throw new Error('AI-svaret var ikke gyldig JSON. Ingenting er fylt inn.'); };
    const r = await sara.post('/declarations/ai', { importer_id: importer, files: [{ filename: 'inv.pdf', mime: 'application/pdf', contentBase64: PDF }] });
    const d = await waitDone(sara, r.body.id);
    expect(d.intakes[0]).toMatchObject({ status: 'FAILED', error: 'AI-svaret var ikke gyldig JSON. Ingenting er fylt inn.' });
    expect(d.items).toHaveLength(0);
    next = async () => ({ data: EXTRACTION, model: 'fake-model', usage: null });
    expect((await sara.post(`/declarations/${d.id}/ai`, {})).status).toBe(200);    // can be started again
    await waitDone(sara, d.id);

    await pool.query('UPDATE business_partner SET ai_off = true WHERE id = $1', [importer]);
    let called = false;
    next = async () => { called = true; return { data: EXTRACTION, model: 'fake-model', usage: null }; };
    const refused = await sara.post('/declarations/ai', { importer_id: importer, files: [{ filename: 'inv.pdf', mime: 'application/pdf', contentBase64: PDF }] });
    expect(refused.body.code).toBe('AI_REFUSED');
    expect(called).toBe(false);
    await pool.query('UPDATE business_partner SET ai_off = false WHERE id = $1', [importer]);

    configured = false;
    expect((await sara.post('/declarations/ai', { files: [{ filename: 'inv.pdf', mime: 'application/pdf', contentBase64: PDF }] })).status).toBe(503);
    configured = true;
    expect((await sara.post('/declarations/ai', { files: [] })).body.code).toBe('NO_DOCUMENTS');
  });
});
