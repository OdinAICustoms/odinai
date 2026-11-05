import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { client, freshDb, PW } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const rules = (b: any) => (b.issues as any[]).map(i => i.rule);

beforeAll(async () => {
  await freshDb();
  await pool.query(`INSERT INTO tariff (code, display, level, text) SELECT lpad(g::text, 8, '0'), lpad(g::text, 8, '0'), 'Code', 'test' FROM generate_series(10000000, 10001100) g`);
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('07143009', '0714 30 09', 'Code', 'jams'), ('19023001', '1902 30 01', 'Code', 'nudler'),
    ('17011490', '1701 14 90', 'Code', 'sukker')`);
  // 0714 30 09: ordinary 2,26 kr/kg, GSP for India (TGS3) 1,57 kr/kg, EFTA–India (TIN) 0. 1902 30 01: RT100 26,58 kr/kg. 1701 14 90: free.
  await pool.query(`INSERT INTO tariff_rate (code, landgruppe, duty_code, rate_value, rate_unit, unit_code, unit_text, valid_from) VALUES
    ('07143009', 'TALL', 'TL1', 2.26, 'SPECIFIC', 'K', 'kr per kg', '2020-01-01'), ('07143009', 'TGS3', 'TL1', 1.57, 'SPECIFIC', 'K', 'kr per kg', '2020-01-01'),
    ('07143009', 'TIN', 'TL1', 0, 'SPECIFIC', 'K', 'kr per kg', '2020-01-01'),
    ('19023001', 'TALL', 'TL1', 0, 'PERCENT', 'P', 'prosent', '2020-01-01'), ('19023001', 'TALL', 'RT100', 26.58, 'SPECIFIC', 'K', 'kr per kg', '2020-01-01'),
    ('17011490', 'TALL', 'TL1', 0, 'PERCENT', 'P', 'prosent', '2020-01-01')`);
  await pool.query(`INSERT INTO landgruppe_country (landgruppe, country_code, valid_from) VALUES ('TGS3', 'IN', '2000-01-01'), ('TIN', 'IN', '2000-01-01'), ('TOES', 'DE', '1994-01-01')`);
  await pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro')`);
  await pool.query(`INSERT INTO fx_rate (currency, valid_from, rate, quoted) VALUES ('EUR', '2020-01-01', 11, 11)`);
});
afterAll(() => pool.end());

describe('calculation through the declaration', () => {
  const sara = client();
  let decl: any, importer = '', other = '', product = '';
  const put = async (b: any) => { const r = await sara.put(`/declarations/${decl.id}`, { ...b, version: decl.version }); expect(r.status, JSON.stringify(r.body)).toBe(200); decl = r.body; return decl; };
  const item = async (b: any) => { const r = await sara.post(`/declarations/${decl.id}/items`, { ...b, version: decl.version }); expect(r.status, JSON.stringify(r.body)).toBe(200); decl = r.body; return decl; };
  const putItem = async (n: number, b: any) => { const it = decl.items[n - 1]; const r = await sara.put(`/declarations/${decl.id}/items/${it.id}`, { ...b, version: decl.version }); expect(r.status, JSON.stringify(r.body)).toBe(200); decl = r.body; return decl; };

  it('setup', async () => {
    const admin = client();
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    const u = await admin.post('/admin/users', { name: 'Sara', email: 'sara@odin.test', roles: ['specialist'] });
    await sara.post('/auth/login', { email: 'sara@odin.test', password: u.body.temporaryPassword });
    await sara.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    const mk = async (name: string, org: string) => {
      const p = (await sara.post('/partners', { legal_name: name, registration_country: 'NO' })).body.partner;
      await sara.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      return p.id as string;
    };
    importer = await mk('Nordlys Matimport AS', '923609016');
    other = await mk('Fjordkaffe AS', '931481274');
    product = (await sara.post('/products', { name: 'Maggi nudler', owner_id: importer, code: '19023001', origin: 'IN' })).body.product.id;
    decl = (await sara.post('/declarations', { importer_id: importer, currency: 'EUR', decl_date: today })).body;
  });

  it('without levy data: VAT at 25 % and a warning; box 46 = price × rate in whole kroner', async () => {
    await item({ description: 'Jams', code: '07143009', origin: 'IN', preference: 'N', procedure: '4000', price: 10.05, net_kg: 50, gross_kg: 52 });
    const l = decl.calc.lines[0];
    expect(l.customsValue).toBe(111);              // 10,05 × 11 = 110,55 → 111
    expect(l.duty).toBe(113);                      // 50 kg × 2,26 = 113 (ordinary: box 36 = N)
    expect(l.vat).toMatchObject({ rate: 25, source: 'DEFAULT', amount: 56 });   // (111 + 113) × 25 % = 56
    expect(rules(decl)).toContain('LEVY_DATA_MISSING');
    expect(rules(decl)).toContain('PAYMENT_REQUIRED');
  });

  it('box 36: G takes the GSP group, never the agreement group; a claim without a rate is an error', async () => {
    await pool.query(`INSERT INTO ref_import_levy (code, levy_type, levy_group, rate, unit) VALUES ('07143009', 'MV', 1, 25, 'P'), ('07143009', 'MV', 2, 15, 'P'),
      ('07143009', 'FA', 200, 0.25, 'P'), ('19023001', 'MV', 1, 25, 'P'), ('19023001', 'MV', 2, 15, 'P'), ('19023001', 'FA', 100, 0.35, 'P'),
      ('17011490', 'MV', 2, 15, 'P'), ('17011490', 'SU', 100, 2.1307, 'KGM'), ('17011490', 'SU', 200, 1.10, 'KGM')`);
    await putItem(1, { preference: 'G', docs: [{ code: 'SER', ref: 'INREX0307015203EC003' }] });
    let l = decl.calc.lines[0];
    expect(l.tl1).toMatchObject({ landgruppe: 'TGS3', source: 'PREFERENCE' });
    expect(l.duty).toBe(79);                       // 50 × 1,57 = 78,5 → 79 (Proteria 441002 2600 548405, item 23)
    expect(l.faAmount).toBe(0);                    // 111 × 0,25 % = 0,28 → 0
    expect(l.vat).toMatchObject({ rate: 15, low: true, source: 'TOLLETATEN', amount: 29 });   // (111 + 79) × 15 % = 28,5 → 29
    expect(rules(decl)).not.toContain('LEVY_DATA_MISSING');
    await putItem(1, { origin: 'US' });
    expect(rules(decl)).toContain('PREF_NO_AGREEMENT');
    expect(decl.calc.lines[0].duty).toBe(113);     // falls back to the ordinary rate, never 0
    await putItem(1, { origin: 'IN' });
  });

  it('RT100: the product\'s permit when held by the importer; another holder gets the published rate and an error', async () => {
    await item({ description: 'Nudler', product_id: product, procedure: '4000', price: 100, net_kg: 209, gross_kg: 230 });
    let l = decl.calc.lines[1];
    expect(l.rt.status).toBe('PUBLISHED_RATE');
    expect(l.rtAmount).toBe(5555);                 // 209 × 26,58 = 5 555,22
    expect(rules(decl)).toContain('RT_FULL_RATE');
    const p = await sara.post('/rt-permits', { product_id: product, holder_id: importer, holder_org_no: '923609016', product_name: 'Maggi nudler', tariff_code: '19023001',
      skriv_tall: '26/R595399', rate_tall: '1,90', skriv_toes: '26/R595398', rate_toes: 0, valid_from: '2026-01-01', valid_to: '2029-01-01' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    decl = (await sara.get(`/declarations/${decl.id}`)).body;
    l = decl.calc.lines[1];
    expect(l.rt).toMatchObject({ status: 'VALID', variant: 'TALL', rate: 1.9, holder: 'OK', amount: 397 });   // 209 × 1,90 = 397,1
    expect(l.faAmount).toBe(4);                    // 1 100 × 0,35 % = 3,85 → 4
    await put({ importer_id: other });
    l = decl.calc.lines[1];
    expect(l.rt.status).toBe('PUBLISHED_RATE');
    expect(rules(decl)).toContain('RT_HOLDER_MISMATCH');
    await put({ importer_id: importer });
  });

  it('excise duties: a choice per levy type, then the amount; box 48 needed once something is payable', async () => {
    await item({ description: 'Sukker', code: '17011490', origin: 'DE', procedure: '4000', price: 50, net_kg: 100 });
    expect(rules(decl)).toContain('LEVY_CHOICE');
    expect(decl.calc.lines[2].levyTypes.map((t: any) => [t.type, t.groups.map((g: any) => g.group)])).toEqual([['SU', ['100', '200']]]);
    await putItem(3, { levies: [{ type: 'SU', group: '100' }] });
    expect(rules(decl)).toContain('LEVY_QTY');
    await putItem(3, { levies: [{ type: 'SU', group: '100', qty: 100 }] });
    expect(decl.calc.lines[2].saerAmount).toBe(213);   // 100 × 2,1307 = 213,07
    await putItem(3, { levies: [{ type: 'su', group: 'na' }] });
    expect(decl.calc.lines[2].saerAmount).toBe(0);
    expect(rules(decl)).not.toContain('LEVY_CHOICE');
    await put({ payment_method: 'KONTANT' });
    expect(rules(decl)).not.toContain('PAYMENT_REQUIRED');
  });

  it('box 12: freight spread by gross mass in whole kroner, adding up exactly; item freight is then not used', async () => {
    await putItem(1, { freight: 50 });
    await put({ value_details: [{ kind: 'ADD', type: 'FRAKT', amount: '1 000', currency: 'NOK' }] });
    expect(decl.value_details[0]).toMatchObject({ basis: 'GROSS', amount: 1000, currency: 'NOK' });
    const shares = decl.calc.lines.map((l: any) => l.add45);
    expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(1000);
    expect(shares).toEqual([184, 816, 0]);         // 52 / 230 kg gross; the sugar line has no gross weight and gets no share
    expect(rules(decl)).toContain('B12_OVERRIDES_ITEM');
    await put({ value_details: [{ kind: 'ADD', type: 'FORSIKRING', amount: 10, currency: 'INV' }, { kind: 'DED', type: 'RABATT', amount: 5 }] });
    expect(decl.calc.box12).toMatchObject({ addTotal: 110, dedTotal: 55, bases: ['VALUE'] });
    await put({ value_details: [] });
    expect(decl.calc.lines[0].add45).toBe(50);    // the item's own freight again
  });

  it('temporary import (5000): calculated, nothing charged', async () => {
    await sara.post(`/declarations/${decl.id}/items/bulk`, { field: 'procedure', value: '5000', version: decl.version });
    decl = (await sara.get(`/declarations/${decl.id}`)).body;
    expect(decl.calc.suspended).toBe(true);
    expect([decl.calc.payable, decl.calc.vat, decl.calc.total]).toEqual([0, 0, 0]);
    expect(decl.calc.lines[1].rt.amount).toBe(397);   // still shown for information
  });
});
