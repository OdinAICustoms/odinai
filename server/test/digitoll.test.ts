import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { check } from '../src/digitoll/rules.js';
import { cudeOf } from '../src/digitoll/service.js';
import { client, freshDb, PW } from './helpers.js';

beforeAll(async () => {
  await freshDb();
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('21039099', '2103 90 99', 'Code', 'ellers')`);
  await pool.query(`INSERT INTO tariff_rate (code, landgruppe, duty_code, rate_value, rate_unit, unit_code, valid_from) VALUES ('21039099', 'TALL', 'TL1', 0, 'PERCENT', 'P', '2020-01-01')`);
  await pool.query(`INSERT INTO ref_import_levy (code, levy_type, levy_group, rate, unit) VALUES ('21039099', 'MV', 2, 15, 'P')`);
  await pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro')`);
  await pool.query(`INSERT INTO fx_rate (currency, valid_from, rate, quoted) VALUES ('EUR', '2020-01-01', 11, 11)`);
});
afterAll(() => pool.end());

const roadTransport = () => ({
  documentIssueDate: '2026-11-05T08:00:00Z',
  activeBorderTransportMeans: { modeOfTransportCode: '3', typeOfIdentification: '30', identificationNumber: 'AB12345', countryCode: 'SE', operator: { name: 'Sven', communication: [{ identifier: '+46700000000', type: 'TE' }] } },
  carrier: { name: 'Nord Transport AB', identificationNumber: 'SE556677889901', address: { city: 'Göteborg', country: 'SE' } },
  customsOfficeOfFirstEntry: { referenceNumber: 'NO377001' },
  scheduledDateAndTimeOfArrival: new Date(Date.now() + 864e5).toISOString().replace(/\.\d+Z$/, 'Z'), estimatedDateAndTimeOfArrival: '', consignmentMasterLevel: []
});

describe('Digitoll rules as pure functions', () => {
  it('a house: required fields, CUDE fields, the procedure table and missing documentation', () => {
    const h = (over: any = {}) => ({ consignmentHouseLevel: { containerIndicator: 0, totalGrossMass: 110, numberOfPackages: 10, goodsDescription: 'Mango chutney',
      transportDocumentHouseLevel: { documentNumber: 'CMR-1', type: 'N730' }, importProcedure: { importProcedure: 'IMMEDIATE_RELEASE_IMPORT', hasOutgoingProcedure: false },
      previousDocuments: [], consignor: { name: 'Euro Food', typeOfPerson: 2, address: { streetLine: 'Gate 1', city: 'Hamburg', country: 'DE' } },
      consignee: { name: 'Nordlys', typeOfPerson: 2, address: { streetLine: 'Vei 2', city: 'Oslo', country: 'NO' } }, ...over } });
    let r = check('HOUSE', 'ROAD', h());
    expect(r.ok).toBe(true);
    expect(r.variant).toBe(1);
    expect(r.issues.map(i => [i.lvl, i.rule, i.reason])).toEqual([['incomplete', 'PREVDOC_MISSING', 'INCOMPLETE_CUDE_DOCUMENTATION']]);
    r = check('HOUSE', 'ROAD', h({ previousDocuments: [{ typeOfReference: 'CUDE', declarantNumber: '931481274', declarationDate: '2026-11-05', sequenceNumber: '12' }] }));
    expect(r.issues).toEqual([]);
    r = check('HOUSE', 'ROAD', h({ previousDocuments: [{ typeOfReference: 'CUDE', declarantNumber: '931481274', sequenceNumber: '1a', referenceNumber: 'X' }] }));
    expect(r.issues.map(i => i.rule)).toEqual(expect.arrayContaining(['CUDE_FIELD', 'CUDE_EITHER', 'SEQ_DIGITS']));
    r = check('HOUSE', 'ROAD', h({ goodsDescription: '', importProcedure: { importProcedure: 'IMMEDIATE_RELEASE_IMPORT', outgoingProcedure: 'XYZ', hasOutgoingProcedure: true } }));
    expect(r.issues.map(i => i.rule)).toEqual(expect.arrayContaining(['REQUIRED', 'PROC_COMBINATION']));
    expect(r.ok).toBe(false);
  });
  it('a transport: identification type for the mode, registration number characters, no consignments yet', () => {
    const t = roadTransport();
    t.activeBorderTransportMeans.typeOfIdentification = '41';
    t.activeBorderTransportMeans.identificationNumber = 'AB 12345';
    expect(check('TRANSPORT', 'ROAD', t).issues.map(i => i.rule).sort()).toEqual(['IDENT_CHARS', 'IDENT_MODE', 'NO_CONSIGNMENTS']);
  });
  it('the CUDE is read from TVINN\'s declaration ID', () => {
    expect(cudeOf('931481274-05112026-12-2')).toEqual({ typeOfReference: 'CUDE', declarantNumber: '931481274', declarationDate: '2026-11-05', sequenceNumber: '12' });
    expect(cudeOf(null)).toBeNull();
  });
});

describe('Digitoll through the API', () => {
  const sara = client(), aron = client();
  let decl: any, house: any, transport: any, master: any;

  it('setup: a sent import declaration', async () => {
    const admin = client();
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    for (const [c, k, role] of [[sara, 'sara', 'specialist'], [aron, 'aron', 'approver']] as const) {
      const u = await admin.post('/admin/users', { name: k, email: `${k}@odin.test`, roles: [role] });
      await c.post('/auth/login', { email: `${k}@odin.test`, password: u.body.temporaryPassword });
      await c.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    }
    const mk = async (name: string, country: string, org: string | null, roles: string[], credit?: string) => {
      const p = (await sara.post('/partners', { legal_name: name, registration_country: country })).body.partner;
      if (org) await sara.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      await sara.post(`/partners/${p.id}/rows/addresses`, { address_type: 'REGISTERED', street: 'Gate 1', city: 'By', country_code: country, is_standard: true });
      for (const r of roles) await sara.post(`/partners/${p.id}/rows/roles`, { role_code: r });
      if (credit) await sara.post(`/partners/${p.id}/rows/credit`, { account: credit, payment_type: 'TOLLKREDITT' });
      return p.id as string;
    };
    const odin = await mk('ODIN CUSTOMS AS', 'NO', '931481274', ['DEC', 'REP']);
    const importer = await mk('Nordlys Matimport AS', 'NO', '923609016', ['IMP', 'DEB'], '412200');
    const exporter = await mk('Euro Food Trading GmbH', 'DE', null, ['EXP']);
    await pool.query(`INSERT INTO bp_fullmakt (partner_id, representative_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [importer, odin]);
    decl = (await sara.post('/declarations', { importer_id: importer, exporter_id: exporter, office: '300101', place: 'Oslo', dispatch_country: 'DE', transport_id: 'AB12345',
      transport_nat: 'SE', transport_mode: '3', incoterms: 'DAP', incoterms_place: 'Oslo', invoice_total: 100, currency: 'EUR', goods_location: 'Lager',
      payment_method: 'TOLLKREDITT', payment_account: '412200', docs: [{ code: 'N380', ref: 'INV-1' }],
      items: [{ description: 'Mango chutney', code: '21039099', origin: 'IN', procedure: '4000', price: 60, net_kg: 10, gross_kg: 11, packages: 6 },
        { description: 'Pickles', code: '21039099', origin: 'IN', procedure: '4000', price: 40, net_kg: 5, gross_kg: 6, packages: 4 }] })).body;
    expect(decl.check.ok, JSON.stringify(decl.issues)).toBe(true);
  });

  it('a house from the declaration: parties, packages, gross mass, goods; the CUDE arrives once the declaration is sent', async () => {
    const r = await sara.post(`/digitoll/houses/from-declaration/${decl.id}`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    house = r.body;
    const h = house.data.consignmentHouseLevel;
    expect(h).toMatchObject({ numberOfPackages: 10, totalGrossMass: 17, goodsDescription: 'Mango chutney; Pickles' });
    expect(h.consignor).toMatchObject({ name: 'Euro Food Trading GmbH', address: { streetLine: 'Gate 1', country: 'DE' } });
    expect(h.consignee).toMatchObject({ name: 'Nordlys Matimport AS', identificationNumber: '923609016' });
    expect(house).toMatchObject({ status: 'DRAFT', declaration_id: decl.id });
    expect(house.check.issues.map((i: any) => i.rule)).toEqual(expect.arrayContaining(['REQUIRED', 'PREVDOC_MISSING']));   // no CMR number yet, no CUDE yet
    expect((await sara.post(`/digitoll/houses/from-declaration/${decl.id}`, {})).body.code).toBe('HOUSE_EXISTS');
    expect((await sara.get(`/declarations/${decl.id}`)).body.digitoll).toMatchObject({ id: house.id, status: 'DRAFT' });

    await sara.post(`/declarations/${decl.id}/submit`, {});
    await aron.post(`/declarations/${decl.id}/approve`, {});
    for (let i = 0; i < 50; i++) { const d = (await sara.get(`/declarations/${decl.id}`)).body; if (d.status === 'ACCEPTED') break; await new Promise(res => setTimeout(res, 100)); }
    house = (await sara.get(`/digitoll/houses/${house.id}`)).body;
    expect(house.data.consignmentHouseLevel.previousDocuments).toEqual([expect.objectContaining({ typeOfReference: 'CUDE', declarantNumber: '931481274', sequenceNumber: String(Number(decl.decl_no.slice(-5))) })]);
  });

  it('send: rejected on errors; accepted with an MRN; key fields locked; an amendment keeps the MRN', async () => {
    let r = (await sara.post(`/digitoll/houses/${house.id}/send`, {})).body;
    expect(r).toMatchObject({ status: 'REJECTED', mrn: null });
    expect(r.answer.errors.map((e: any) => e.rule)).toContain('REQUIRED');
    const data = structuredClone(r.data);
    data.consignmentHouseLevel.transportDocumentHouseLevel.documentNumber = 'CMR-7781';
    r = (await sara.put(`/digitoll/houses/${house.id}`, { data, version: r.version })).body;
    r = (await sara.post(`/digitoll/houses/${house.id}/send`, {})).body;
    expect(r).toMatchObject({ status: 'ACCEPTED', doc_number: 'CMR-7781', pending_change: false, variant: 1 });
    expect(r.mrn).toMatch(/^\d{2}NODT[0-9A-F]{12}$/);
    const mrn = r.mrn;
    expect((await sara.post(`/digitoll/houses/${house.id}/send`, {})).body.code).toBe('NOTHING_TO_SEND');
    const locked = structuredClone(r.data); locked.consignmentHouseLevel.transportDocumentHouseLevel.documentNumber = 'OTHER';
    expect((await sara.put(`/digitoll/houses/${house.id}`, { data: locked, version: r.version })).body.code).toBe('LOCKED');
    const amend = structuredClone(r.data); amend.consignmentHouseLevel.numberOfPackages = 11;
    r = (await sara.put(`/digitoll/houses/${house.id}`, { data: amend, version: r.version })).body;
    expect(r.pending_change).toBe(true);
    r = (await sara.post(`/digitoll/houses/${house.id}/send`, {})).body;
    expect(r).toMatchObject({ status: 'ACCEPTED', mrn, pending_change: false });
    expect(r.messages.filter((m: any) => m.direction === 'OUT').map((m: any) => m.operation)).toEqual(['PUT', 'POST', 'POST']);
    await expect(pool.query('DELETE FROM digitoll_message')).rejects.toThrow(/insert-only/);
    house = r;
  });

  it('a transport and a master: links, INCOMPLETE without consignments, cancel needs a reason and no active children; arrival', async () => {
    transport = (await sara.post('/digitoll/transports', { data: roadTransport() })).body;
    let t = (await sara.post(`/digitoll/transports/${transport.id}/send`, {})).body;
    expect(t).toMatchObject({ status: 'INCOMPLETE', means_id: 'AB12345' });
    expect(t.answer.incompleteDocumentationReasons).toEqual(['INCOMPLETE_DOCUMENTATION']);
    master = (await sara.post('/digitoll/masters', {})).body;
    const m = structuredClone(master.data);
    Object.assign(m.consignmentMasterLevel, { grossMass: 17, transportDocumentMasterLevel: { documentNumber: 'MCMR-1', type: 'N730' },
      consignor: { name: 'Euro Food', typeOfPerson: 2, address: { streetLine: 'Gate 1', country: 'DE' } }, consignee: { name: 'Nordlys', typeOfPerson: 2, address: { streetLine: 'Vei 2', country: 'NO' } } });
    master = (await sara.put(`/digitoll/masters/${master.id}`, { data: m, transport_id: transport.id, version: master.version })).body;
    expect(master.links.transport.id).toBe(transport.id);
    house = (await sara.put(`/digitoll/houses/${house.id}`, { master_id: master.id, version: house.version })).body;
    expect(house).toMatchObject({ master_id: master.id, transport_id: null });
    t = (await sara.get(`/digitoll/transports/${transport.id}`)).body;
    expect(t.check.issues.map((i: any) => i.rule)).not.toContain('NO_CONSIGNMENTS');
    expect((await sara.post(`/digitoll/transports/${transport.id}/cancel`, { reason: 'x' })).body.code).toBe('HAS_CHILDREN');
    expect((await sara.post(`/digitoll/houses/${house.id}/cancel`, {})).body.code).toBe('REASON_REQUIRED');
    const ov = (await sara.get('/digitoll')).body;
    expect(ov.attention.map((a: any) => [a.kind, a.id])).toEqual(expect.arrayContaining([['TRANSPORT', transport.id], ['HOUSE', house.id]]));   // incomplete; house changed after sending
    t = (await sara.post(`/digitoll/transports/${transport.id}/arrival`, {})).body;
    expect(t.arrival_registered_at).toBeTruthy();
    const c = (await sara.post(`/digitoll/masters/${master.id}/cancel`, { reason: 'Feil hovedforsendelse' })).body;
    expect(c.code).toBe('HAS_CHILDREN');
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE object_type = 'DIGITOLL' ORDER BY id`)).rows.map(r => r.action);
    expect(actions).toEqual(expect.arrayContaining(['DIGITOLL_CREATED', 'DIGITOLL_SENT', 'DIGITOLL_CHANGED', 'DIGITOLL_ARRIVAL']));
  });
});
