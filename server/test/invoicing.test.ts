import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import * as R from '../src/invoicing/pricing.js';
import { client, freshDb, PW } from './helpers.js';

beforeAll(async () => {
  await freshDb();
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('21039099', '2103 90 99', 'Code', 'ellers')`);
  await pool.query(`INSERT INTO tariff_rate (code, landgruppe, duty_code, rate_value, rate_unit, unit_code, valid_from) VALUES ('21039099', 'TALL', 'TL1', 10, 'PERCENT', 'P', '2020-01-01')`);
  await pool.query(`INSERT INTO ref_import_levy (code, levy_type, levy_group, rate, unit) VALUES ('21039099', 'MV', 2, 15, 'P')`);
  await pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro')`);
  await pool.query(`INSERT INTO fx_rate (currency, valid_from, rate, quoted) VALUES ('EUR', '2020-01-01', 11, 11)`);
  await pool.query(`UPDATE price_item SET price = 650 WHERE code = 'DECL_IMP'`);
  await pool.query(`UPDATE price_item SET price = 45, free_lines = 5 WHERE code = 'EXTRA_LINE'`);
});
afterAll(() => pool.end());

const T = (o: Partial<R.DeclForInvoice> = {}): R.DeclForInvoice => ({ id: 'd1', decl_no: 'IMP-2026-00001', direction: 'IMPORT', mrn: null, decl_date: '2026-11-05',
  itemCount: 3, calc: { duty: 110, rt: 0, fa: 4, saer: 0, tillegg: 0, vat: 182 }, payer: 'ODIN', account: '999001', ...o });
const ITEMS: R.PriceItem[] = [
  { code: 'DECL_IMP', name_no: 'Fortolling innførsel', unit: 'PER_DECL', applies_to: 'IMPORT', mva_code: 'HIGH', price: 650, free_lines: null },
  { code: 'DECL_EXP', name_no: 'Utførselsdeklarasjon', unit: 'PER_DECL', applies_to: 'EXPORT', mva_code: 'HIGH', price: 0, free_lines: null },
  { code: 'EXTRA_LINE', name_no: 'Tillegg per varepost', unit: 'PER_LINE', applies_to: 'ALL', mva_code: 'HIGH', price: 45, free_lines: 5 },
  { code: 'CREDIT_FEE', name_no: 'Kredittprovisjon', unit: 'PERCENT_DUTY', applies_to: 'IMPORT', mva_code: 'HIGH', price: 0, free_lines: null }
];
const list = (code: string): R.Price | null => { const i = ITEMS.find(x => x.code === code)!; return { price: Number(i.price), freeLines: i.free_lines, source: 'LIST' }; };

describe('Invoicing rules as pure functions', () => {
  it('Odin paid: fee, outlays for duty and levies, credit commission; import VAT is never recharged', () => {
    const prices = (code: string): R.Price | null => code === 'CREDIT_FEE' ? { price: 2, freeLines: null, source: 'AGREEMENT' }
      : code === 'EXTRA_LINE' ? { price: 40, freeLines: 1, source: 'AGREEMENT' } : list(code);
    const r = R.propose(T(), ITEMS, prices, { vatRegistered: true });
    expect(r.lines.map(l => [l.item_code, l.quantity, l.unit_price, l.vat_code, l.price_source])).toEqual([
      ['DECL_IMP', 1, 650, 'HIGH', 'LIST'], ['EXTRA_LINE', 2, 40, 'HIGH', 'AGREEMENT'], ['CREDIT_FEE', 1, 2.28, 'HIGH', 'AGREEMENT'],
      ['TOLL', 1, 110, 'OUTLAY', 'CALCULATION'], ['FA', 1, 4, 'OUTLAY', 'CALCULATION']]);
    expect(r.lines[2].description).toContain('2 % av 114,00 kr');
    expect(r.warnings).toEqual([]);
    const priced = r.lines.map(l => ({ ...l, ...R.priceLine(l, true) }));
    expect(R.totals(priced)).toEqual({ net_total: 732.28, vat_total: 183.07, outlay_total: 114, deposit_applied: 0, total: 1029.35 });
    expect(R.totals(priced, 200).total).toBe(829.35);
    expect(R.vatSummary(priced)).toEqual([{ code: 'HIGH', rate: 25, base: 732.28, vat: 183.07 }, { code: 'OUTLAY', rate: 0, base: 114, vat: 0 }]);
    expect(R.priceLine({ quantity: 1, unit_price: 100, vat_code: 'HIGH' }, false)).toEqual({ amount: 100, vat_code: 'HIGH', vat_rate: 0, vat_amount: 0 });
  });
  it('the client paid: no outlay and no commission; an unknown account and a missing price are warnings, never guesses', () => {
    expect(R.propose(T({ payer: 'CLIENT' }), ITEMS, list, { vatRegistered: true }).lines.map(l => l.item_code)).toEqual(['DECL_IMP']);
    const u = R.propose(T({ payer: 'UNKNOWN', account: '555555' }), ITEMS, list, { vatRegistered: true });
    expect(u.lines.map(l => l.line_type)).toEqual(['FEE']);
    expect(u.warnings.map(w => w.rule)).toEqual(['PAYER_UNKNOWN']);
    const e = R.propose(T({ direction: 'EXPORT', decl_no: 'EXP-2026-00002', calc: { levy: 30 }, itemCount: 7 }), ITEMS, list, { vatRegistered: true });
    expect(e.lines.map(l => [l.item_code, l.quantity, l.unit_price])).toEqual([['EXTRA_LINE', 2, 45], ['UTFORSEL', 1, 30]]);
    expect(e.warnings.map(w => w.rule)).toEqual(['NO_PRICE']);
    const p = R.propose(T(), ITEMS, list, { vatRegistered: false });
    expect(p.warnings.map(w => w.rule)).toEqual(['CLIENT_NOT_VAT_REGISTERED']);
  });
  it('KID with MOD10, Norwegian account numbers with MOD11, dates', () => {
    const k = R.kid('BP-00042', 10001);
    expect(k).toMatch(/^00004200100\d{3}$/);
    expect(k).toHaveLength(14);
    expect(R.validKid(k)).toBe(true);
    expect(R.validKid(k.slice(0, -1) + ((Number(k.slice(-1)) + 1) % 10))).toBe(false);
    expect(R.mod10('7992739871')).toBe('3');
    expect(R.validAccount('8601 11 17947')).toBe(true);
    expect(R.validAccount('86011117948')).toBe(false);
    expect(R.formatAccount('86011117947')).toBe('8601.11.17947');
    expect(R.endOfPreviousMonth('2026-03-15')).toBe('2026-02-28');
    expect(R.addDays('2026-12-25', 14)).toBe('2027-01-08');
  });
});

describe('Invoicing through the API', () => {
  const sara = client(), aron = client(), fia = client();
  let importer = '', declA: any, declB: any, draft: any, invoice: any;

  const accepted = async (account: string, ref: string) => {
    const d = (await sara.post('/declarations', { importer_id: importer, office: '300101', place: 'Oslo', dispatch_country: 'DE', transport_id: 'AB12345', own_ref: ref,
      transport_nat: 'SE', transport_mode: '3', incoterms: 'DAP', incoterms_place: 'Oslo', invoice_total: 100, currency: 'EUR', goods_location: 'Lager',
      payment_method: 'TOLLKREDITT', payment_account: account, docs: [{ code: 'N380', ref: 'INV-' + ref }],
      exporter_id: (await pool.query("SELECT id FROM business_partner WHERE legal_name = 'Euro Food Trading GmbH'")).rows[0].id,
      items: [{ description: 'Mango chutney', code: '21039099', origin: 'IN', procedure: '4000', price: 60, net_kg: 10, gross_kg: 11, packages: 6 },
        { description: 'Pickles', code: '21039099', origin: 'IN', procedure: '4000', price: 40, net_kg: 5, gross_kg: 6, packages: 4 }] })).body;
    expect(d.check?.ok, JSON.stringify(d.issues ?? d)).toBe(true);
    await sara.post(`/declarations/${d.id}/submit`, {});
    await aron.post(`/declarations/${d.id}/approve`, {});
    for (let i = 0; i < 60; i++) { const x = (await sara.get(`/declarations/${d.id}`)).body; if (x.status === 'ACCEPTED') return x; await new Promise(res => setTimeout(res, 100)); }
    throw new Error('not accepted');
  };

  it('setup: users, Odin with its own credit account, a client with its own, two accepted declarations', async () => {
    const admin = client();
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    for (const [c, k, role] of [[sara, 'sara', 'specialist'], [aron, 'aron', 'approver'], [fia, 'fia', 'finance']] as const) {
      const u = await admin.post('/admin/users', { name: k, email: `${k}@odin.test`, roles: [role] });
      await c.post('/auth/login', { email: `${k}@odin.test`, password: u.body.temporaryPassword });
      await c.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    }
    const mk = async (name: string, country: string, org: string | null, roles: string[], credit?: string, invoiceAddress = false) => {
      const p = (await sara.post('/partners', { legal_name: name, registration_country: country })).body.partner;
      if (org) await sara.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      await sara.post(`/partners/${p.id}/rows/addresses`, { address_type: 'REGISTERED', street: 'Gate 1', postal_code: '0150', city: 'Oslo', country_code: country, is_standard: true });
      if (invoiceAddress) await sara.post(`/partners/${p.id}/rows/addresses`, { address_type: 'INVOICE', street: 'Postboks 77', postal_code: '0101', city: 'Oslo', country_code: country });
      for (const r of roles) await sara.post(`/partners/${p.id}/rows/roles`, { role_code: r });
      if (credit) await sara.post(`/partners/${p.id}/rows/credit`, { account: credit, payment_type: 'TOLLKREDITT' });
      return p.id as string;
    };
    const odin = await mk('ODIN CUSTOMS AS', 'NO', '931481274', ['DEC', 'REP'], '999001');
    importer = await mk('Nordlys Matimport AS', 'NO', '923609016', ['IMP', 'DEB'], '412200', true);
    await mk('Euro Food Trading GmbH', 'DE', null, ['EXP']);
    await pool.query(`INSERT INTO bp_fullmakt (partner_id, representative_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [importer, odin]);
    // The client's agreement: extra goods items at 40 kr with one free, 2 % credit commission.
    expect((await fia.post(`/partners/${importer}/prices`, { item_code: 'EXTRA_LINE', price: 40, free_lines: 1 })).status).toBe(200);
    expect((await fia.post(`/partners/${importer}/prices`, { item_code: 'CREDIT_FEE', price: 2 })).status).toBe(200);
    declA = await accepted('999001', 'A');   // Odin's account: duty is an outlay
    declB = await accepted('412200', 'B');   // the client's own account: nothing to recharge
  });

  it('the basis: both declarations under the client, outlays and commission only where Odin paid', async () => {
    const b = (await fia.get('/invoicing/basis')).body;
    expect(b.gaps).toEqual(expect.arrayContaining(['adresse', 'kontonummer']));
    expect(b.clients).toHaveLength(1);
    const c = b.clients[0];
    expect(c.client.legal_name).toBe('Nordlys Matimport AS');
    const a = c.declarations.find((d: any) => d.id === declA.id), bb = c.declarations.find((d: any) => d.id === declB.id);
    const duty = (await pool.query(`SELECT (snapshot->'calc'->>'duty')::numeric d FROM declaration_version WHERE declaration_id = $1 AND result = 'ACCEPTED'`, [declA.id])).rows[0].d;
    expect(Number(duty)).toBeGreaterThan(0);
    expect(a.payer).toBe('ODIN');
    expect(a.lines.map((l: any) => l.item_code)).toEqual(['DECL_IMP', 'EXTRA_LINE', 'CREDIT_FEE', 'TOLL']);
    expect(a.lines.find((l: any) => l.item_code === 'TOLL').unit_price).toBe(Number(duty));
    expect(a.lines.find((l: any) => l.item_code === 'EXTRA_LINE')).toMatchObject({ quantity: 1, unit_price: 40, price_source: 'AGREEMENT' });
    expect(bb.payer).toBe('CLIENT');
    expect(bb.lines.map((l: any) => l.item_code)).toEqual(['DECL_IMP', 'EXTRA_LINE']);
    expect((await sara.get('/invoicing/basis')).status).toBe(200);
    expect((await sara.post('/invoicing/run', {})).status).toBe(403);
  });

  it('drafts: one per declaration, discarded back to the basis, then one monthly draft; never twice', async () => {
    let r = (await fia.post('/invoicing/run', { upTo: '2999-12-31' })).body;
    expect(r.created).toHaveLength(2);
    expect((await fia.get('/invoicing/basis')).body.clients).toEqual([]);
    expect((await fia.post('/invoices', { clientId: importer, declarationIds: [declA.id] })).body.code).toBe('ALREADY_INVOICED');
    for (const c of r.created) expect((await fia.post(`/invoices/${c.id}/discard`, { reason: 'Månedlig i stedet' })).body.status).toBe('DISCARDED');
    expect((await fia.get('/invoicing/basis')).body.clients[0].declarations).toHaveLength(2);
    await fia.put(`/partners/${importer}/invoicing`, { consolidation: 'MONTHLY', due_days: 20, invoice_email: 'faktura@nordlys.test' });
    r = (await fia.post('/invoicing/run', {})).body;   // default: up to the end of last month — nothing is due yet
    expect(r.created).toEqual([]);
    r = (await fia.post('/invoicing/run', { upTo: '2999-12-31' })).body;
    expect(r.created).toHaveLength(1);
    draft = (await fia.get(`/invoices/${r.created[0].id}`)).body;
    expect(draft).toMatchObject({ status: 'DRAFT', invoice_no: null, consolidation: 'MONTHLY', editable: true });
    expect(draft.declarations.map((d: any) => d.id).sort()).toEqual([declA.id, declB.id].sort());
    expect(draft.warnings.map((w: any) => w.rule)).toEqual(['SETTINGS_INCOMPLETE']);
    expect((await pool.query("SELECT count(*) n FROM invoice WHERE status = 'DISCARDED'")).rows[0].n).toBe(2);
  });

  it('a draft is edited: a changed price keeps the agreed one, an hour line, a removed line, totals follow', async () => {
    const fee = draft.lines.find((l: any) => l.item_code === 'DECL_IMP' && l.declaration_id === declB.id);
    let r = await fia.put(`/invoices/${draft.id}/lines/${fee.id}`, { unit_price: 500, version: draft.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lines.find((l: any) => l.id === fee.id)).toMatchObject({ unit_price: '500.00', agreed_price: '650.00' });
    expect(r.body.warnings.map((w: any) => w.rule)).toContain('PRICE_CHANGED');
    expect((await fia.put(`/invoices/${draft.id}/lines/${fee.id}`, { unit_price: 1, version: draft.version })).body.code).toBe('VERSION');
    r = await fia.post(`/invoices/${draft.id}/lines`, { item_code: 'HOUR', description: 'Klassifisering av nye varer', quantity: 1.5, unit: 'timer', unit_price: 900, vat_code: 'HIGH' });
    expect(r.body.lines.find((l: any) => l.item_code === 'HOUR')).toMatchObject({ line_type: 'SERVICE', amount: '1350.00', vat_amount: '337.50', price_source: 'MANUAL' });
    const extra = r.body.lines.find((l: any) => l.item_code === 'EXTRA_LINE' && l.declaration_id === declB.id);
    r = await fia.post(`/invoices/${draft.id}/lines/${extra.id}/remove`, {});
    draft = r.body;
    const live = draft.lines.filter((l: any) => !l.removed_at);
    expect(draft.lines.find((l: any) => l.id === extra.id).removed_at).toBeTruthy();
    const sum = (f: (l: any) => boolean, k = 'amount') => Math.round(live.filter(f).reduce((s: number, l: any) => s + Number(l[k]), 0) * 100) / 100;
    expect(Number(draft.net_total)).toBe(sum(l => l.vat_code !== 'OUTLAY'));
    expect(Number(draft.outlay_total)).toBe(sum(l => l.vat_code === 'OUTLAY'));
    expect(Number(draft.total)).toBe(Math.round((sum(l => l.vat_code !== 'OUTLAY') + sum(() => true, 'vat_amount') + sum(l => l.vat_code === 'OUTLAY')) * 100) / 100);
    expect((await fia.post(`/invoices/${draft.id}/lines`, { description: 'x', quantity: 0, unit_price: 1 })).body.code).toBe('QUANTITY');
    const pdf = await fia.get(`/invoices/${draft.id}/pdf`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await pool.query("SELECT count(*) n FROM document WHERE owner_type = 'INVOICE'")).rows[0].n).toBe(0);   // a preview is not stored
  });

  it('issuing needs the company details; then a number, KID, due date, the PDF, and the invoice is frozen', async () => {
    expect((await fia.post(`/invoices/${draft.id}/issue`, {})).body.code).toBe('SETTINGS_INCOMPLETE');
    expect((await sara.put('/invoicing/settings', { company: { street: 'x' } })).status).toBe(403);
    expect((await fia.put('/invoicing/settings', { company: { bankAccount: '86011117948' } })).body.code).toBe('ACCOUNT_INVALID');
    const s = (await fia.put('/invoicing/settings', { company: { street: 'Oscars gate 27', postalCode: '0352', city: 'Oslo', bankAccount: '8601.11.17947', email: 'post@odin.test' } })).body;
    expect(s.company.bankAccount).toBe('86011117947');
    expect(s.nextNo).toBe(10001);
    expect((await sara.post(`/invoices/${draft.id}/issue`, {})).status).toBe(403);
    expect((await fia.post(`/invoices/${draft.id}/issue`, { issueDate: '2999-01-01' })).body.code).toBe('FUTURE_DATE');
    const r = await fia.post(`/invoices/${draft.id}/issue`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    invoice = r.body;
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
    expect(invoice).toMatchObject({ status: 'ISSUED', display: 'OPEN', invoice_no: 10001, issue_date: today, due_date: R.addDays(today, 20), editable: false });
    expect(R.validKid(invoice.kid)).toBe(true);
    expect(invoice.kid.slice(0, 6)).toBe('000002');   // BP-00002, the client
    expect(invoice.buyer).toMatchObject({ name: 'Nordlys Matimport AS', street: 'Postboks 77', orgNo: '923609016', email: 'faktura@nordlys.test' });
    expect(invoice.seller).toMatchObject({ name: 'ODIN CUSTOMS AS', bankAccount: '86011117947' });
    expect(invoice.document_id).toBeTruthy();
    const pdf = await fia.get(`/invoices/${invoice.id}/pdf`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.headers['content-disposition']).toContain('Faktura-10001.pdf');
    expect((await sara.post(`/documents/${invoice.document_id}/remove`, {})).body.code).toBe('INVOICE_DOCUMENT');
    expect((await sara.get(`/declarations/${declA.id}`)).body.invoice).toMatchObject({ invoice_no: 10001, status: 'ISSUED' });
    // Frozen: no edits through the API, and the database refuses changes and deletes.
    expect((await fia.put(`/invoices/${invoice.id}`, { note: 'x' })).body.code).toBe('NOT_DRAFT');
    expect((await fia.post(`/invoices/${invoice.id}/discard`, {})).body.code).toBe('NOT_DRAFT');
    await expect(pool.query('UPDATE invoice SET total = 1 WHERE id = $1', [invoice.id])).rejects.toThrow(/credit it instead/);
    await expect(pool.query('DELETE FROM invoice WHERE id = $1', [invoice.id])).rejects.toThrow(/never deleted/);
    await expect(pool.query('UPDATE invoice_line SET unit_price = 1 WHERE invoice_id = $1', [invoice.id])).rejects.toThrow(/cannot change/);
    expect((await fia.get('/invoices?status=OPEN')).body.map((i: any) => i.invoice_no)).toEqual([10001]);
    expect((await fia.get('/invoices?q=10001')).body).toHaveLength(1);
    expect((await fia.get(`/invoices?q=${declB.decl_no}`)).body).toHaveLength(1);
  });

  it('credit notes: one line first, then the rest; the invoice is credited and the declarations return to the basis', async () => {
    expect((await fia.post(`/invoices/${invoice.id}/credit`, {})).body.code).toBe('REASON_REQUIRED');
    const hour = invoice.lines.find((l: any) => l.item_code === 'HOUR');
    let r = await fia.post(`/invoices/${invoice.id}/credit`, { reason: 'Timene var inkludert i avtalen', lineIds: [hour.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c1 = r.body;
    expect(c1).toMatchObject({ kind: 'CREDIT', status: 'ISSUED', invoice_no: 10002, total: '-1687.50', credits: { invoice_no: 10001 } });
    expect(c1.lines[0]).toMatchObject({ quantity: '-1.500', amount: '-1350.00', vat_amount: '-337.50', credits_line_id: hour.id });
    let inv = (await fia.get(`/invoices/${invoice.id}`)).body;
    expect(inv).toMatchObject({ status: 'ISSUED', credited: 1687.5 });
    expect(inv.open).toBe(Math.round((Number(invoice.total) - 1687.5) * 100) / 100);
    expect(inv.lines.find((l: any) => l.id === hour.id).credited_by_no).toBe(10002);
    expect((await fia.post(`/invoices/${invoice.id}/credit`, { reason: 'x', lineIds: [hour.id] })).body.code).toBe('LINE_NOT_OPEN');
    r = await fia.post(`/invoices/${invoice.id}/credit`, { reason: 'Feil klient' });
    expect(r.body.invoice_no).toBe(10003);
    inv = (await fia.get(`/invoices/${invoice.id}`)).body;
    expect(inv).toMatchObject({ status: 'CREDITED', display: 'CREDITED', open: 0, credited: Number(invoice.total) });
    expect(inv.creditNotes.map((c: any) => c.invoice_no)).toEqual([10002, 10003]);
    expect((await fia.post(`/invoices/${invoice.id}/credit`, { reason: 'x' })).body.code).toBe('NOT_CREDITABLE');
    expect((await fia.get('/invoicing/basis')).body.clients[0].declarations).toHaveLength(2);
    expect((await sara.get(`/declarations/${declA.id}`)).body.invoice).toBeNull();
    const pdf = await fia.get(`/invoices/${r.body.id}/pdf`).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(pdf.headers['content-disposition']).toContain('Kreditnota-10003.pdf');
  });

  it('the number series only moves forward and has no gaps; everything is in the audit log', async () => {
    expect((await fia.put('/invoicing/settings', { nextNo: 10002 })).body.code).toBe('SERIES_BACKWARDS');
    expect((await fia.put('/invoicing/settings', { nextNo: 20001 })).body.nextNo).toBe(20001);
    const d = (await fia.post('/invoices', { clientId: importer, declarationIds: [declA.id] })).body;
    expect(d.lines.length).toBeGreaterThan(0);
    // Two issues at once: one gets the number, the other is refused, and the series has no gap.
    const [x, y] = await Promise.all([fia.post(`/invoices/${d.id}/issue`, {}), fia.post(`/invoices/${d.id}/issue`, {})]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await pool.query('SELECT invoice_no FROM invoice WHERE invoice_no IS NOT NULL ORDER BY invoice_no')).rows.map(r => r.invoice_no)).toEqual([10001, 10002, 10003, 20001]);
    const actions = (await pool.query("SELECT action FROM audit_log WHERE object_type IN ('INVOICE', 'SETTINGS') ORDER BY id")).rows.map(r => r.action);
    expect(actions).toEqual(expect.arrayContaining(['INVOICE_DRAFTED', 'INVOICE_DISCARDED', 'INVOICE_LINE_CHANGED', 'INVOICE_LINE_ADDED', 'INVOICE_LINE_REMOVED',
      'INVOICE_SETTINGS', 'INVOICE_ISSUED', 'INVOICE_CREDITED', 'CREDIT_NOTE_ISSUED', 'DOCUMENT_STORED']));
    const sum = (await fia.get('/invoicing/summary')).body;
    expect(sum).toMatchObject({ drafts: 0, open: 1, basis: 1 });
  });
});
