import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { validOrgNo, validPersonNo, overlaps, checkIdentifier, searchName } from '../src/partners/rules.js';
import { applicability } from '../src/partners/eori.js';
import { client, freshDb, PW } from './helpers.js';

/* Stand-ins for Brønnøysund (REST) and the EU EORI service (SOAP), answering in their real shapes. */
const UNIT = { organisasjonsnummer: '923609016', navn: 'NORDLYS MATIMPORT AS', organisasjonsform: { kode: 'AS', beskrivelse: 'Aksjeselskap' },
  forretningsadresse: { adresse: ['Brynsveien 14'], postnummer: '0667', poststed: 'OSLO', landkode: 'NO', kommune: 'OSLO' },
  postadresse: { adresse: ['Postboks 12'], postnummer: '0601', poststed: 'OSLO', landkode: 'NO' },
  registrertIMvaregisteret: true, konkurs: false, underAvvikling: false, epostadresse: 'Post@Nordlys.test', telefon: '22 00 00 00' };
const ROLES = { rollegrupper: [{ roller: [{ type: { kode: 'DAGL' }, person: { navn: { fornavn: 'Kari', etternavn: 'Holm' }, fodselsdato: '1970-01-01' } }] }] };
let srv: http.Server, nameNow = UNIT.navn;
beforeAll(async () => {
  await freshDb();
  srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => (body += c)); req.on('end', () => {
      if (req.url?.startsWith('/brreg/enheter/923609016/roller')) return res.end(JSON.stringify(ROLES));
      if (req.url?.startsWith('/brreg/enheter/923609016')) return res.end(JSON.stringify({ ...UNIT, navn: nameNow }));
      if (req.url?.startsWith('/brreg/enheter?navn=')) return res.end(JSON.stringify({ _embedded: { enheter: [UNIT] } }));
      if (req.url?.startsWith('/brreg/enheter/')) { res.statusCode = 404; return res.end('{}'); }
      if (req.url === '/eori') {
        const e = body.match(/<ev:eori>([^<]+)</)![1];
        const ok = e === 'DE813306551203749';
        return res.end(`<S:Envelope><S:Body><ns2:validateEORIResponse><return><result><eori>${e}</eori><status>${ok ? 0 : 1}</status>` +
          `<statusDescr>${ok ? 'Valid' : 'Not valid'}</statusDescr>${ok ? '<name>Euro Food Trading GmbH</name><street>Großmarkt 9</street><postalCode>20097</postalCode><city>Hamburg</city>' : ''}</result></return></ns2:validateEORIResponse></S:Body></S:Envelope>`);
      }
      res.statusCode = 404; res.end();
    });
  });
  await new Promise<void>(r => srv.listen(0, r));
  const port = (srv.address() as any).port;
  process.env.BRREG_BASE = `http://127.0.0.1:${port}/brreg`;
  process.env.EORI_BASE = `http://127.0.0.1:${port}/eori`;
  await pool.query("INSERT INTO country (code, name) VALUES ('NO','Norge'), ('DE','Tyskland'), ('SE','Sverige') ON CONFLICT DO NOTHING");
});
afterAll(async () => { srv.close(); await pool.end(); });

describe('rules', () => {
  it('organisation and person numbers use the official check digits', () => {
    expect(validOrgNo('923 609 016')).toBe(true);
    expect(validOrgNo('923609017')).toBe(false);
    expect(validPersonNo('01010150055')).toBe(false);
    expect(checkIdentifier({ identifier_type: 'ORG_NO', identifier_value: '12345' })[0].rule).toBe('ORG_NO_FORMAT');
    expect(checkIdentifier({ identifier_type: 'ORG_NO', identifier_value: '923609017' })[0].lvl).toBe('warn');
    expect(checkIdentifier({ identifier_type: 'EORI', identifier_value: '12AB' })[0].rule).toBe('EORI_FORMAT');
  });
  it('dates, names and EORI routing', () => {
    expect(overlaps({ valid_from: '2026-01-01', valid_to: null }, { valid_from: '2025-01-01', valid_to: '2026-01-01' })).toBe(true);
    expect(overlaps({ valid_from: '2026-01-02' }, { valid_to: '2026-01-01' })).toBe(false);
    expect(searchName('Nordlys Mat-import A/S')).toBe('NORDLYS MAT IMPORT A S');
    expect(applicability('NO923609016').ok).toBe(false);
    expect(applicability('GB123456789000').ok).toBe(false);
    expect(applicability('DE813306551203749').ok).toBe(true);
  });
});

describe('partners', () => {
  const admin = client(), spec = client(), view = client();
  let id = '', supplierId = '', odinId = '', dupId = '';
  it('setup: users with different roles', async () => {
    await admin.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    for (const [c, email, roles] of [[spec, 'sara@odin.test', ['specialist']], [view, 'vera@odin.test', ['viewer']]] as const) {
      const u = await admin.post('/admin/users', { name: email, email, roles });
      await c.post('/auth/login', { email, password: u.body.temporaryPassword });
      await c.post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    }
  });
  it('import from Brønnøysund: name, org. no., EORI, VAT, addresses, contact, live status', async () => {
    const s = await spec.get('/partners/brreg/search?q=nordlys');
    expect(s.body[0].orgNo).toBe('923609016');
    expect(s.body[0].partner).toBeNull();
    const r = await spec.post('/partners/brreg/import', { orgNo: '923609016', is_client: true, roles: ['IMP', 'CON', 'DEB'] });
    expect(r.status).toBe(200);
    const p = r.body.partner; id = p.id;
    expect(p.partner_no).toMatch(/^BP-\d{5}$/);
    expect([p.orgNo, p.eori, p.vatNo]).toEqual(['923609016', 'NO923609016', 'NO923609016MVA']);
    expect(p.addressText).toBe('Brynsveien 14, 0667 OSLO');
    expect(p.activeRoles.sort()).toEqual(['CON', 'DEB', 'IMP']);
    expect(p.contacts[0]).toMatchObject({ contact_name: 'Kari Holm', email: 'post@nordlys.test' });
    expect(JSON.stringify(p.registry.roles)).not.toContain('1970');             // names only, never birth dates
    expect((await spec.post('/partners/brreg/import', { orgNo: '923609016' })).body.code).toBe('EXISTS');
    expect((await spec.get('/partners/brreg/search?q=nordlys')).body[0].partner.partner_no).toBe(p.partner_no);
  });
  it('manual partner with a version check', async () => {
    const r = await spec.post('/partners', { legal_name: 'Euro Food Trading GmbH', registration_country: 'DE' });
    supplierId = r.body.partner.id;
    expect((await spec.post('/partners', { legal_name: '', registration_country: 'DE' })).body.code).toBe('NAME_REQUIRED');
    expect((await spec.post('/partners', { legal_name: 'X', registration_country: 'ZZ' })).body.code).toBe('COUNTRY');
    const v = r.body.partner.version;
    expect((await spec.put(`/partners/${supplierId}`, { legal_name: 'Euro Food Trading GmbH', registration_country: 'DE', version: v, default_incoterms: 'fca', default_incoterms_place: 'Hamburg' })).body.partner.default_incoterms).toBe('FCA');
    expect((await spec.put(`/partners/${supplierId}`, { legal_name: 'Old', registration_country: 'DE', version: v })).body.code).toBe('VERSION');
    expect((await view.post('/partners', { legal_name: 'Nope', registration_country: 'NO' })).status).toBe(403);
  });
  it('dated rows: one standard address at a time, duplicate roles refused, rows ended not deleted', async () => {
    const a = await spec.post(`/partners/${supplierId}/rows/addresses`, { address_type: 'REGISTERED', street: 'Großmarkt 9', postal_code: '20097', city: 'Hamburg', country_code: 'de', is_standard: true });
    expect(a.body.partner.addressText).toBe('Großmarkt 9, 20097 Hamburg, DE');
    const b = await spec.post(`/partners/${supplierId}/rows/addresses`, { address_type: 'WAREHOUSE', street: 'Lager 1', city: 'Bremen', country_code: 'DE', is_standard: true });
    expect(b.body.code).toBe('STANDARD_OVERLAP');
    await spec.post(`/partners/${supplierId}/rows/roles`, { role_code: 'CNR' });
    expect((await spec.post(`/partners/${supplierId}/rows/roles`, { role_code: 'CNR' })).body.code).toBe('ROLE_DUPLICATE');
    const sup = await spec.post(`/partners/${supplierId}/rows/roles`, { role_code: 'SUP' });
    const role = sup.body.partner.roles.find((r: any) => r.role_code === 'SUP');
    const ended = await spec.post(`/partners/${supplierId}/rows/roles/${role.id}/end`, {});
    expect(ended.body.partner.activeRoles).toEqual(['CNR']);
    expect(ended.body.partner.roles.find((r: any) => r.id === role.id).status).toBe('ENDED');
    expect((await spec.post(`/partners/${supplierId}/rows/contacts`, { contact_type: 'CUSTOMS', clearance_mail: true })).body.code).toBe('CONTACT_EMPTY');
    expect((await spec.post(`/partners/${supplierId}/rows/contacts`, { contact_type: 'CUSTOMS', contact_name: 'Hans', clearance_mail: true })).body.code).toBe('CONTACT_MAIL_NO_EMAIL');
  });
  it('EORI check against the EU service, and the Norwegian EORI routed to Brønnøysund', async () => {
    const r = await spec.post(`/partners/${supplierId}/rows/identifiers`, { identifier_type: 'EORI', identifier_value: 'de 8133 0655 1203 749' });
    const e = r.body.partner.identifiers.find((i: any) => i.identifier_type === 'EORI');
    expect(e.identifier_value).toBe('DE813306551203749');
    const c = await spec.post(`/partners/${supplierId}/identifiers/${e.id}/check-eori`);
    expect(c.body.partner.identifiers.find((i: any) => i.id === e.id)).toMatchObject({ check_status: 'VALID', check_name: 'Euro Food Trading GmbH' });
    const no = (await spec.get(`/partners/${id}`)).body.identifiers.find((i: any) => i.identifier_type === 'EORI');
    const n = await spec.post(`/partners/${id}/identifiers/${no.id}/check-eori`);
    expect(n.body.warnings[0].rule).toBe('EORI_NOT_APPLICABLE');
  });
  it('duplicate org. no. is a warning that suggests merging', async () => {
    dupId = (await spec.post('/partners', { legal_name: 'Nordlys Mat (gammel)', registration_country: 'NO' })).body.partner.id;
    const r = await spec.post(`/partners/${dupId}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: '923 609 016' });
    expect(r.status).toBe(200);
    expect(r.body.warnings.map((w: any) => w.rule)).toContain('ORG_NO_DUPLICATE');
    expect((await spec.get(`/partners/${id}`)).body.duplicates.map((d: any) => d.id)).toEqual([dupId]);
  });
  it('fullmakt, links and credit accounts', async () => {
    odinId = (await spec.post('/partners', { legal_name: 'ODIN CUSTOMS AS', registration_country: 'NO' })).body.partner.id;
    const f = await spec.post(`/partners/${id}/fullmakt`, { representative_id: odinId, representation: 'DIRECT', valid_from: '2026-01-01', valid_to: '2027-06-30' });
    expect(f.body.partner.fullmakt[0]).toMatchObject({ rep_name: 'ODIN CUSTOMS AS', scope: 'IMPORT_EXPORT' });
    expect((await spec.post(`/partners/${id}/fullmakt`, { representative_id: id, valid_from: '2026-01-01' })).body.code).toBe('FULLMAKT_SELF');
    const l = await spec.post(`/partners/${id}/relationships`, { target_partner_id: supplierId, relationship_type: 'OTHER', notes: 'Hovedleverandør' });
    expect(l.body.partner.relationships[0].target_name).toBe('Euro Food Trading GmbH');
    const c = await spec.post(`/partners/${id}/rows/credit`, { account: '41220', payment_type: 'TOLLKREDITT' });
    expect(c.body.partner.credit[0].account).toBe('41220');
    expect((await spec.post(`/partners/${supplierId}/rows/credit`, { account: '41220' })).body.code).toBe('CREDIT_TAKEN');
    expect((await spec.post(`/partners/${id}/rows/credit`, { account: '12' })).body.code).toBe('CREDIT_ACCOUNT');
  });
  it('prices are locked: a new price starts later, history kept, never back-dated', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const r = await spec.post(`/partners/${id}/prices`, { item_code: 'DECL_IMP', price: '450', valid_from: today });
    expect(r.body.partner.prices[0]).toMatchObject({ item_code: 'DECL_IMP', price: '450.00' });
    expect((await spec.post(`/partners/${id}/prices`, { item_code: 'DECL_IMP', price: '500', valid_from: today })).body.code).toBe('PRICE_LOCKED');
    expect((await spec.post(`/partners/${id}/prices`, { item_code: 'DECL_IMP', price: '500', valid_from: '2020-01-01' })).body.code).toBe('PRICE_BACKDATED');
    const n = await spec.post(`/partners/${id}/prices`, { item_code: 'DECL_IMP', price: '495,50', valid_from: later });
    const rows = n.body.partner.prices.filter((x: any) => x.item_code === 'DECL_IMP');
    expect(rows.map((x: any) => x.price)).toEqual(['495.50', '450.00']);
    expect(rows[1].valid_to).toBeTruthy();
    const { priceFor } = await import('../src/partners/repo.js');
    expect((await priceFor(id, 'DECL_IMP', today))!.price).toBe('450.00');
    expect((await priceFor(id, 'DECL_IMP', later))!.price).toBe('495.50');
    expect((await priceFor(id, 'HOUR', today))!.source).toBe('LIST');
    expect((await spec.put(`/partners/${id}/invoicing`, { consolidation: 'MONTHLY' })).status).toBe(403);   // finance or approver
  });
  it('Brønnøysund refresh shows differences and applies them on request', async () => {
    nameNow = 'NORDLYS MATIMPORT AS AVD OSLO';
    const r = await spec.post(`/partners/${id}/brreg/refresh`);
    expect(r.body.diff.name).toEqual({ card: 'NORDLYS MATIMPORT AS', registry: 'NORDLYS MATIMPORT AS AVD OSLO' });
    expect(r.body.diff.address).toBeNull();
    const a = await spec.post(`/partners/${id}/brreg/apply`, { name: true });
    expect(a.body.partner.legal_name).toBe('NORDLYS MATIMPORT AS AVD OSLO');
  });
  it('list and lookup find partners by name, number and identifier', async () => {
    expect((await spec.get('/partners?q=nordlys')).body.length).toBe(2);
    expect((await spec.get('/partners?q=923 609 016')).body.length).toBe(2);
    expect((await spec.get('/partners?q=DE81330655')).body[0].legal_name).toBe('Euro Food Trading GmbH');
    expect((await spec.get('/partners?client=1')).body.map((p: any) => p.id)).toEqual([id]);
    expect((await spec.get('/partners?role=IMP')).body.map((p: any) => p.id)).toEqual([id]);
    const lk = await spec.get('/partners/lookup?box=f8&q=nord');
    expect(lk.body[0]).toMatchObject({ id, hasRole: true });
  });
  it('merge moves everything to the partner kept and leaves a trace', async () => {
    expect((await spec.post(`/partners/${dupId}/merge`, { target: id })).status).toBe(403);   // approver or admin
    const m = await admin.post(`/partners/${dupId}/merge`, { target: id });
    expect(m.status).toBe(200);
    const gone = (await admin.get(`/partners/${dupId}`)).body;
    expect(gone).toMatchObject({ status: 'INACTIVE', mergedIntoNo: m.body.partner.partner_no });
    expect(m.body.partner.duplicates).toEqual([]);
    expect((await admin.get('/partners?q=nordlys')).body.length).toBe(1);
    expect((await admin.put(`/partners/${dupId}`, { legal_name: 'x', registration_country: 'NO' })).body.code).toBe('MERGED');
    expect((await admin.post(`/partners/${dupId}/reactivate`)).body.code).toBe('MERGED');
  });
  it('every change is in the audit log for the partner', async () => {
    const log = (await admin.get(`/admin/audit?objectType=PARTNER&objectId=${id}&limit=100`)).body as any[];
    const actions = new Set(log.map(r => r.action));
    for (const a of ['PARTNER_CREATED', 'FULLMAKT_ADDED', 'PARTNER_LINK_ADDED', 'PARTNER_ROW_ADDED', 'PRICE_LOCKED', 'BRREG_CHECKED', 'BRREG_APPLIED', 'PARTNER_MERGED'])
      expect(actions).toContain(a);
    expect(log.find(r => r.action === 'PRICE_LOCKED' && r.changes?.DECL_IMP?.[1] === 495.5)).toBeTruthy();
  });
});
