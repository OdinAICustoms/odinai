import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { check, type RuleContext } from '../src/declarations/rules.js';
import { client, freshDb, PW } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const rules = (body: any) => (body.issues as any[]).map(i => i.rule);

beforeAll(async () => {
  await freshDb();
  // Reference data: a loaded tariff (over 1,000 codes), offices, procedures, a currency with a rate, a CHED restriction.
  await pool.query(`INSERT INTO tariff (code, display, level, text) SELECT lpad(g::text, 8, '0'), lpad(g::text, 8, '0'), 'Code', 'test' FROM generate_series(10000000, 10001100) g`);
  await pool.query(`INSERT INTO tariff (code, display, level, text, supp_unit, supp_text, valid_to) VALUES
    ('21039099', '2103 90 99', 'Code', 'ellers', NULL, NULL, NULL), ('21030000', '2103 00 00', 'Other', 'Sauser', NULL, NULL, NULL),
    ('64039900', '6403 99 00', 'Code', 'sko', 'NPR', 'par', NULL), ('04032040', '0403 20 40', 'Code', 'yoghurt', 'KGM', 'kilogram', NULL),
    ('09109900', '0910 99 00', 'Code', 'krydder', NULL, NULL, '2020-12-31')`);
  await pool.query(`INSERT INTO ref_office (code, name, direction, valid_from) VALUES ('300101', 'Ereg innførsel', 'Innførsel', '2024-01-01'), ('300102', 'Ereg utførsel', 'Utførsel', '2024-01-01')`);
  await pool.query(`INSERT INTO ref_procedure (code, text) VALUES ('4000', 'Fri disponering'), ('5000', 'Midlertidig innførsel')`);
  await pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro'), ('USD', 'Dollar')`);
  await pool.query(`INSERT INTO fx_rate (currency, valid_from, rate, quoted) VALUES ('EUR', '2020-01-01', 11.6, 11.6)`);
  await pool.query(`INSERT INTO restriction (code, landgruppe, restriction_code, document_code) VALUES ('04032040', 'RALL', 'V5', 'CHED')`);
  // Duty free with VAT data, so the calculation (phase 2b) adds no findings to the 2a rules tested here.
  await pool.query(`INSERT INTO tariff_rate (code, landgruppe, duty_code, rate_value, rate_unit, valid_from)
    SELECT c, 'TALL', 'TL1', 0, 'PERCENT', '2020-01-01' FROM unnest(ARRAY['21039099', '64039900', '04032040', '21030000', '09109900']) c`);
  await pool.query(`INSERT INTO ref_import_levy (code, levy_type, levy_group, rate, unit) VALUES ('21039099', 'MV', 2, 15, 'P')`);
});
afterAll(() => pool.end());

describe('import declarations', () => {
  const admin = client(), sara = client(), view = client();
  let odin = '', importer = '', exporter = '', product = '', decl = '', version = 0;
  const reload = async () => { const r = await sara.get(`/declarations/${decl}`); version = r.body.version; return r.body; };

  it('setup: users, Odin as declarant, an importer with credit, an exporter', async () => {
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    for (const [c, name, email, role] of [[sara, 'Sara', 'sara@odin.test', 'specialist'], [view, 'Vera', 'vera@odin.test', 'viewer']] as const) {
      const u = await admin.post('/admin/users', { name, email, roles: [role] });
      await c.post('/auth/login', { email, password: u.body.temporaryPassword });
      await c.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    }
    const mk = async (name: string, country: string, org: string | null, roles: string[], credit?: [string, string]) => {
      const p = (await sara.post('/partners', { legal_name: name, registration_country: country })).body.partner;
      if (org) await sara.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      await sara.post(`/partners/${p.id}/rows/addresses`, { address_type: 'REGISTERED', street: 'Gate 1', city: 'Oslo', country_code: country, is_standard: true });
      for (const r of roles) await sara.post(`/partners/${p.id}/rows/roles`, { role_code: r });
      if (credit) await sara.post(`/partners/${p.id}/rows/credit`, { account: credit[0], payment_type: credit[1] });
      return p.id as string;
    };
    odin = await mk('ODIN CUSTOMS AS', 'NO', '931481274', ['DEC', 'REP'], ['654321', 'DAGSOPPGJOR']);
    importer = await mk('Nordlys Matimport AS', 'NO', '923609016', ['IMP', 'DEB'], ['412200', 'TOLLKREDITT']);
    exporter = await mk('Euro Food Trading GmbH', 'DE', null, ['EXP']);
    product = (await sara.post('/products', { name: 'Mango chutney', descr: 'Mango chutney i glass', owner_id: importer, code: '21039099', origin: 'IN' })).body.product.id;
  });

  it('a new draft: number, Odin in box 14, type 4, today, the importer as client; empty draft lists what is missing', async () => {
    const r = await sara.post('/declarations', { importer_id: importer });
    expect(r.status).toBe(200);
    decl = r.body.id; version = r.body.version;
    expect(r.body).toMatchObject({ decl_no: expect.stringMatching(/^IMP-\d{4}-\d{5}$/), status: 'DRAFT', declarant_id: odin, decl_type: '4',
      decl_date: today, client_id: importer, transaction_type: '01', editable: true });
    expect(r.body.parties.declarant.legal_name).toBe('ODIN CUSTOMS AS');
    expect(r.body.check.ok).toBe(false);
    expect(rules(r.body)).toEqual(expect.arrayContaining(['MANDATORY', 'NO_ITEMS', 'NO_DOCS']));
    expect(r.body.issues.find((i: any) => i.field === 'exporter_id')).toMatchObject({ box: '2', lvl: 'err' });
  });

  it('formats are checked on save; nothing is stored half', async () => {
    expect((await sara.put(`/declarations/${decl}`, { office: '30010', version })).body.code).toBe('FORMAT');
    expect((await sara.put(`/declarations/${decl}`, { dispatch_country: 'Germany', version })).status).toBe(400);
    expect((await sara.put(`/declarations/${decl}`, { incoterms: 'XYZ', version })).status).toBe(400);
    expect((await sara.put(`/declarations/${decl}`, { invoice_total: '-5', version })).status).toBe(400);
    expect((await reload()).office).toBeNull();
  });

  it('a complete declaration passes; values are normalised; the item takes its text, code and origin from the product', async () => {
    let r = await sara.put(`/declarations/${decl}`, { version, exporter_id: exporter, office: '300 101', place: 'Oslo', dispatch_country: 'de', transport_id: 'AB12345',
      transport_nat: 'de', transport_mode: '3', incoterms: 'dap', incoterms_place: 'Oslo', invoice_total: '1 250,50', currency: 'eur', goods_location: 'Lager Alnabru',
      payment_method: 'TOLLKREDITT', payment_account: '412200', docs: [{ code: 'n380', ref: 'INV-77', date: '2026-10-30' }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ office: '300101', dispatch_country: 'DE', incoterms: 'DAP', invoice_total: '1250.50', currency: 'EUR', box1: 'EU' });
    expect(r.body.docs).toEqual([{ code: 'N380', ref: 'INV-77', date: '2026-10-30' }]);
    r = await sara.post(`/declarations/${decl}/items`, { version: r.body.version, product_id: product, procedure: '4000', price: '1250,50', net_kg: 100, gross_kg: 110, packages: 10, package_kind: 'CT' });
    expect(r.body.items[0]).toMatchObject({ line_no: 1, description: 'Mango chutney i glass', code: '21039099', origin: 'IN', product_no: expect.any(String) });
    // The product is a draft in the register and Odin represents the importer without a fullmakt: warnings, not errors.
    expect(r.body.check).toMatchObject({ ok: true, errors: 0 });
    expect(rules(r.body).sort()).toEqual(['FULLMAKT_MISSING', 'PRODUCT_NOT_CHECKED']);
    await pool.query(`INSERT INTO bp_fullmakt (partner_id, representative_id, valid_from) VALUES ($1, $2, '2026-01-01')`, [importer, odin]);
    expect(rules(await reload())).toEqual(['PRODUCT_NOT_CHECKED']);
  });

  it('the rules: tariff, supplementary unit, procedure, CHED, value, credit account (9110), office, date (9018)', async () => {
    let r = await sara.post(`/declarations/${decl}/items`, { version, description: 'Sko', code: '64039900', origin: 'CN', procedure: '4001', price: 10, net_kg: 2 });
    r = await sara.post(`/declarations/${decl}/items`, { version: r.body.version, description: 'Yoghurt', code: '04032040', origin: 'DE', procedure: '4000', price: 5, net_kg: 1, gross_kg: 0.5 });
    r = await sara.post(`/declarations/${decl}/items`, { version: r.body.version, description: 'Saus', code: '21030000', origin: 'DE', procedure: '4000', price: 5, net_kg: 1 });
    r = await sara.post(`/declarations/${decl}/items`, { version: r.body.version, description: 'Krydder', code: '09109900', origin: 'IN', procedure: '4000', price: 5, net_kg: 1 });
    const by = (rule: string) => r.body.issues.filter((i: any) => i.rule === rule).map((i: any) => i.item ?? i.box);
    expect(by('SUPP_UNIT')).toEqual([2]);                // pairs for shoes; kilogram for yoghurt needs nothing extra
    expect(by('PROC_NOT_IN_TVINN')).toEqual([2]);
    expect(by('CHED_MISSING')).toEqual([3]);
    expect(by('NET_OVER_GROSS')).toEqual([3]);
    expect(by('CODE_NOT_LEAF')).toEqual([4]);
    expect(by('CODE_NOT_VALID_ON_DATE')).toEqual([5]);
    expect(by('VALUE_MISMATCH')).toEqual(['22']);
    expect(r.body.check.ok).toBe(false);
    // A VT line with the CHED number clears the CHED warning.
    const yoghurt = r.body.items[2].id;
    r = await sara.put(`/declarations/${decl}/items/${yoghurt}`, { version: r.body.version, docs: [{ code: 'vt', ref: 'CHEDP.NO.2026.0000830' }] });
    expect(rules(r.body)).not.toContain('CHED_MISSING');
    r = await sara.put(`/declarations/${decl}`, { version: r.body.version, payment_account: '999999' });
    expect(rules(r.body)).toContain('CREDIT_UNKNOWN');
    r = await sara.put(`/declarations/${decl}`, { version: r.body.version, payment_account: '654321' });
    expect(rules(r.body)).toContain('ACCOUNT_TYPE');       // Odin's account is daily settlement, not customs credit
    r = await sara.put(`/declarations/${decl}`, { version: r.body.version, office: '300102', decl_date: plus(-100) });
    expect(rules(r.body)).toEqual(expect.arrayContaining(['OFFICE_EXPORT_ONLY', 'DATE_OLDER_90']));
    r = await sara.put(`/declarations/${decl}`, { version: r.body.version, office: '300101', decl_date: today, payment_account: '412200' });
    version = r.body.version;
  });

  it('items: remove renumbers, move reorders, one value on all items, a product fills only empty fields', async () => {
    let body = await reload();
    const [, shoes, , sauce, spice] = body.items.map((i: any) => i.id);
    body = (await sara.post(`/declarations/${decl}/items/${sauce}/remove`, { version })).body;
    body = (await sara.post(`/declarations/${decl}/items/${spice}/remove`, { version: body.version })).body;
    expect(body.items.map((i: any) => [i.line_no, i.description])).toEqual([[1, 'Mango chutney i glass'], [2, 'Sko'], [3, 'Yoghurt']]);
    body = (await sara.post(`/declarations/${decl}/items/${shoes}/move`, { to: 1, version: body.version })).body;
    expect(body.items.map((i: any) => i.description)).toEqual(['Sko', 'Mango chutney i glass', 'Yoghurt']);
    const bulk = await sara.post(`/declarations/${decl}/items/bulk`, { field: 'procedure', value: '4000', version: body.version });
    expect(bulk.body.changed).toBe(1);
    expect(bulk.body.items.every((i: any) => i.procedure === '4000')).toBe(true);
    expect((await sara.post(`/declarations/${decl}/items/bulk`, { field: 'price', value: 1, version: bulk.body.version })).status).toBe(400);
    body = (await sara.put(`/declarations/${decl}/items/${shoes}`, { version: bulk.body.version, description: 'Joggesko', product_id: product })).body;
    expect(body.items[0]).toMatchObject({ description: 'Joggesko', code: '64039900', origin: 'CN', product_id: product });   // kept, not overwritten
    version = body.version;
  });

  it('two users: a save on an old version is refused; a viewer cannot change anything', async () => {
    expect((await sara.put(`/declarations/${decl}`, { own_ref: 'A', version: version - 1 })).body.code).toBe('VERSION');
    expect((await view.put(`/declarations/${decl}`, { own_ref: 'A', version })).status).toBe(403);
    expect((await view.post('/declarations', {})).status).toBe(403);
    expect((await view.get(`/declarations/${decl}`)).status).toBe(200);
    // The administrator role alone does not write declarations (the first administrator is also an approver).
    const u = await admin.post('/admin/users', { name: 'Adam', email: 'adam@odin.test', roles: ['admin'] });
    const adam = client();
    await adam.post('/auth/login', { email: 'adam@odin.test', password: u.body.temporaryPassword });
    await adam.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    expect((await adam.post('/declarations', {})).status).toBe(403);
  });

  it('temporary import: deadline, transaction type, 5xxx procedure, TXT per item', async () => {
    const d = await sara.post('/declarations', { importer_id: importer, decl_type: '5', items: [{ description: 'Demo', code: '21039099', origin: 'DE', procedure: '4000', price: 1, net_kg: 1 }] });
    expect(rules(d.body)).toEqual(expect.arrayContaining(['TEMP_TRANSACTION', 'TEMP_PROCEDURE', 'TEMP_TXT', 'REEXPORT_DEADLINE_MISSING']));
    const r = await sara.put(`/declarations/${d.body.id}`, { version: d.body.version, reexport_deadline: today, transaction_type: '06' });
    expect(rules(r.body)).toContain('REEXPORT_DEADLINE');
    expect(rules(r.body)).not.toContain('TEMP_TRANSACTION');
  });

  it('copy makes a new draft with the same goods; cancel needs a reason and freezes it; nothing is deleted', async () => {
    const cp = await sara.post(`/declarations/${decl}/copy`, {});
    expect(cp.body).toMatchObject({ status: 'DRAFT', created_from: 'COPY', exporter_id: exporter, docs: [] });
    expect(cp.body.decl_no).not.toBe((await reload()).decl_no);
    expect(cp.body.items.map((i: any) => i.description)).toEqual(['Joggesko', 'Mango chutney i glass', 'Yoghurt']);
    expect((await sara.post(`/declarations/${cp.body.id}/cancel`, { version: cp.body.version })).body.code).toBe('REASON_REQUIRED');
    const c = await sara.post(`/declarations/${cp.body.id}/cancel`, { version: cp.body.version, reason: 'Feil kopi' });
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Feil kopi', editable: false });
    expect((await sara.put(`/declarations/${cp.body.id}`, { own_ref: 'x' })).body.code).toBe('NOT_EDITABLE');
    expect((await sara.get('/declarations')).body.map((d: any) => d.id)).not.toContain(cp.body.id);
    expect((await sara.get('/declarations?all=1')).body.map((d: any) => d.id)).toContain(cp.body.id);
    expect((await sara.get('/declarations?q=Joggesko')).body.length).toBe(1);
  });

  it('box 48 offers the importer\'s customs credit first; every step is in the audit log', async () => {
    const p = await sara.get(`/declarations/${decl}/payment-options`);
    expect(p.body.suggested).toMatchObject({ account: '412200', box: '8', debtor: true });
    expect(p.body.accounts.map((a: any) => a.account)).toEqual(['412200', '654321']);
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE object_type = 'DECLARATION' AND object_id = $1 ORDER BY id`, [decl])).rows.map(r => r.action);
    expect(actions).toEqual(expect.arrayContaining(['DECLARATION_CREATED', 'DECLARATION_CHANGED', 'DECLARATION_ITEM_ADDED', 'DECLARATION_ITEM_REMOVED',
      'DECLARATION_ITEM_MOVED', 'DECLARATION_ITEMS_BULK', 'DECLARATION_ITEM_CHANGED']));
    const change = (await pool.query(`SELECT changes FROM audit_log WHERE action = 'DECLARATION_CHANGED' AND object_id = $1 ORDER BY id LIMIT 1`, [decl])).rows[0].changes;
    expect(change.office).toEqual([null, '300101']);
  });
});

describe('rules as pure functions', () => {
  const base = (): RuleContext => ({
    decl: { decl_type: '4', decl_date: '2026-11-04', docs: [{ code: 'N380', ref: '1' }], transport_mode: '5' }, items: [], today: '2026-11-04', parties: {},
    tariffLoaded: false, tariff: {}, codeValidity: {}, chedCodes: [], officesLoaded: false, office: null, proceduresLoaded: false, procedures: {}, quotas: {},
    currencyKnown: true, fxFound: true, products: {}
  });
  it('box 21 is not asked for post; rules that need reference data stay quiet until it is loaded', () => {
    const x = base();
    x.items = [{ line_no: 1, description: 'a', code: '99999999', origin: 'DE', procedure: '9999', price: 1, net_kg: 1 }];
    const out = check(x);
    expect(out.some(i => i.box === '21')).toBe(false);
    expect(out.map(i => i.rule)).not.toEqual(expect.arrayContaining(['CODE_UNKNOWN']));
    expect(out.map(i => i.rule)).not.toContain('PROC_NOT_IN_TVINN');
  });
  it('a preference without proof of origin; a quota for another code; an expired item permit', () => {
    const x = base();
    x.quotas = { T1: { valid_from: '2026-01-01', valid_to: '2026-12-31', codes: ['06021021'] } };
    x.items = [{ line_no: 1, description: 'a', code: '21039099', origin: 'IN', procedure: '4000', price: 1, net_kg: 1, preference: 'G', quota: 'T1',
      docs: [{ code: 'VT', ref: 'X', valid: '2026-10-01' }] }];
    expect(check(x).map(i => i.rule)).toEqual(expect.arrayContaining(['PREF_NO_PROOF', 'QUOTA_CODE', 'ITEM_DOC_EXPIRED']));
    x.items[0].docs.push({ code: 'SER', ref: 'fakturaerklæring' });
    expect(check(x).map(i => i.rule)).not.toContain('PREF_NO_PROOF');
  });
  it('declaration date older than 365 days is TVINN 9017', () => {
    const x = base();
    x.decl.decl_date = '2025-10-01';
    expect(check(x).find(i => i.rule === 'DATE_OLDER_365')!.msg).toMatch(/9017/);
  });
});
