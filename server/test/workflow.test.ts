import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { client, freshDb, PW } from './helpers.js';

const today = new Date().toISOString().slice(0, 10);
const ddmmyyyy = `${today.slice(8, 10)}${today.slice(5, 7)}${today.slice(0, 4)}`;

beforeAll(async () => {
  process.env.SIM_STAT_CHECK = 'on';
  await freshDb();
  await pool.query(`INSERT INTO tariff (code, display, level, text) SELECT lpad(g::text, 8, '0'), lpad(g::text, 8, '0'), 'Code', 'test' FROM generate_series(10000000, 10001100) g`);
  await pool.query(`INSERT INTO tariff (code, display, level, text) VALUES ('21039099', '2103 90 99', 'Code', 'ellers')`);
  await pool.query(`INSERT INTO tariff_rate (code, landgruppe, duty_code, rate_value, rate_unit, unit_code, valid_from) VALUES ('21039099', 'TALL', 'TL1', 10, 'PERCENT', 'P', '2020-01-01')`);
  await pool.query(`INSERT INTO ref_import_levy (code, levy_type, levy_group, rate, unit) VALUES ('21039099', 'MV', 2, 15, 'P')`);
  await pool.query(`INSERT INTO ref_office (code, name, direction, valid_from) VALUES ('300101', 'Ereg innførsel', 'Innførsel', '2020-01-01')`);
  await pool.query(`INSERT INTO ref_procedure (code, text) VALUES ('4000', 'Fri disponering')`);
  await pool.query(`INSERT INTO currency (code, name) VALUES ('EUR', 'Euro')`);
  await pool.query(`INSERT INTO fx_rate (currency, valid_from, rate, quoted) VALUES ('EUR', '2020-01-01', 11, 11)`);
  await pool.query(`INSERT INTO tvinn_error_code (number, text, box) VALUES ('9110', 'Deklaranten har ikke den oppgitte kredittavtalen', 'f48')`);
});
afterAll(async () => { delete process.env.TVINN_ADAPTER; await pool.end(); });

const users: Record<string, ReturnType<typeof client>> = {};
let importer = '', exporter = '';
const card = async (id: string) => (await users.sara.get(`/declarations/${id}`)).body;
const waitFor = async (id: string, statuses: string[]) => {
  for (let i = 0; i < 60; i++) { const d = await card(id); if (statuses.includes(d.status)) return d; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`not ${statuses.join('/')}: ${(await card(id)).status}`);
};
/** A complete declaration that passes the check. */
async function complete(over: Record<string, unknown> = {}, price = 100) {
  const r = await users.sara.post('/declarations', { importer_id: importer, exporter_id: exporter, office: '300101', place: 'Oslo', dispatch_country: 'DE', transport_id: 'AB1',
    transport_nat: 'DE', transport_mode: '3', incoterms: 'DAP', incoterms_place: 'Oslo', invoice_total: price, currency: 'EUR', goods_location: 'Lager',
    payment_method: 'TOLLKREDITT', payment_account: '412200', docs: [{ code: 'N380', ref: 'INV-1' }], ...over,
    items: [{ description: 'Mango chutney', code: '21039099', origin: 'IN', procedure: '4000', price, net_kg: 10, gross_kg: 11 }] });
  expect(r.body.check, JSON.stringify(r.body.issues)).toMatchObject({ ok: true });
  return r.body;
}

describe('submit, four eyes, TVINN', () => {
  it('setup: a specialist, an approver, an administrator; partners with roles, addresses and credit', async () => {
    users.ada = client();
    await users.ada.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW });
    for (const [k, name, role] of [['sara', 'Sara', 'specialist'], ['aron', 'Aron', 'approver']] as const) {
      const u = await users.ada.post('/admin/users', { name, email: `${k}@odin.test`, roles: [role] });
      users[k] = client();
      await users[k].post('/auth/login', { email: `${k}@odin.test`, password: u.body.temporaryPassword });
      await users[k].post('/auth/password', { current: u.body.temporaryPassword, next: PW });
    }
    const mk = async (name: string, country: string, org: string | null, roles: string[], credit?: string) => {
      const p = (await users.sara.post('/partners', { legal_name: name, registration_country: country })).body.partner;
      if (org) await users.sara.post(`/partners/${p.id}/rows/identifiers`, { identifier_type: 'ORG_NO', identifier_value: org, is_primary: true });
      await users.sara.post(`/partners/${p.id}/rows/addresses`, { address_type: 'REGISTERED', street: 'Gate 1', city: 'By', country_code: country, is_standard: true });
      for (const r of roles) await users.sara.post(`/partners/${p.id}/rows/roles`, { role_code: r });
      if (credit) await users.sara.post(`/partners/${p.id}/rows/credit`, { account: credit, payment_type: 'TOLLKREDITT' });
      return p.id as string;
    };
    const odin = await mk('ODIN CUSTOMS AS', 'NO', '931481274', ['DEC', 'REP']);
    importer = await mk('Nordlys Matimport AS', 'NO', '923609016', ['IMP', 'DEB'], '412200');
    exporter = await mk('Euro Food Trading GmbH', 'DE', null, ['EXP']);
    await pool.query(`INSERT INTO bp_fullmakt (partner_id, representative_id, valid_from) VALUES ($1, $2, '2020-01-01')`, [importer, odin]);
  });

  it('submit is blocked by errors and by open AI review points; then the version is frozen', async () => {
    const bad = (await users.sara.post('/declarations', { importer_id: importer })).body;
    expect((await users.sara.post(`/declarations/${bad.id}/submit`, {})).body.code).toBe('HAS_ERRORS');
    const d = await complete();
    await pool.query(`INSERT INTO declaration_review (declaration_id, kind, msg) VALUES ($1, 'TOTALS', 'Sjekk')`, [d.id]);
    expect((await users.sara.post(`/declarations/${d.id}/submit`, {})).body.code).toBe('REVIEWS_OPEN');
    await pool.query(`UPDATE declaration_review SET status = 'CLEARED' WHERE declaration_id = $1`, [d.id]);
    const s = await users.sara.post(`/declarations/${d.id}/submit`, { version: d.version + 1 });
    expect(s.body.code).toBe('VERSION');
    const ok = (await users.sara.post(`/declarations/${d.id}/submit`, {})).body;
    expect(ok).toMatchObject({ status: 'SUBMITTED', current_version: 1, editable: false });
    expect(ok.versions[0]).toMatchObject({ version_no: 1, submitted_by_name: 'Sara', decision: null });
    expect((await users.sara.put(`/declarations/${d.id}`, { own_ref: 'x' })).body.code).toBe('NOT_EDITABLE');
    const snap = (await pool.query('SELECT snapshot FROM declaration_version WHERE declaration_id = $1', [d.id])).rows[0].snapshot;
    expect(snap.calc.duty).toBe(110);              // 100 EUR × 11 = 1 100 kr × 10 %
    expect(snap.items).toHaveLength(1);

    // A specialist cannot approve; the approver approves; the simulator accepts with MRN and expedition number.
    expect((await users.sara.post(`/declarations/${d.id}/approve`, {})).status).toBe(403);
    const a = (await users.aron.post(`/declarations/${d.id}/approve`, {})).body;
    expect(['APPROVED', 'SENT', 'ACCEPTED']).toContain(a.status);
    const done = await waitFor(d.id, ['ACCEPTED']);
    expect(done.mrn).toMatch(/^\d{2}NO300101[0-9A-F]{8}$/);
    expect(done.tvinn_no).toMatch(/^300101 \d{2}00 \d{6}$/);
    expect(done.versions[0]).toMatchObject({ decision: 'APPROVED', decided_by_name: 'Aron', result: 'ACCEPTED', has_message: true,
      tvinn_id: `931481274-${ddmmyyyy}-${Number(d.decl_no.slice(-5))}-1` });
    expect(done.versions[0].answer).toMatchObject({ decision: 'Frigitt', simulator: true });
    expect(done.queue[0]).toMatchObject({ status: 'DONE', adapter: 'simulator', attempts: 1 });
    const edi = await users.sara.get(`/declarations/${d.id}/versions/1/message`);
    expect(edi.text).toMatch(/^UNB\+UNOC:3/);
    expect(edi.text).toContain(`UNH+${d.decl_no}+CUSDEC:D:96B:UN'`);     // box 7 is empty: the declaration number
    expect(edi.text).toContain(`BGM+929+931481274-${ddmmyyyy}-${Number(d.decl_no.slice(-5))}-1+9'`);
    expect(edi.text).toContain("CST+1+21039099'");
    expect(edi.text).toContain("RFF+AGA:412200'");
    const actions = (await pool.query(`SELECT action FROM audit_log WHERE object_id = $1 ORDER BY id`, [d.id])).rows.map(r => r.action);
    expect(actions).toEqual(expect.arrayContaining(['DECLARATION_SUBMITTED', 'DECLARATION_APPROVED', 'TVINN_ANSWER']));
  });

  it('four eyes: nobody approves their own submission, until an administrator switches it off', async () => {
    const d = await complete();
    await users.aron.post(`/declarations/${d.id}/submit`, {});
    expect((await users.aron.post(`/declarations/${d.id}/approve`, {})).body.code).toBe('FOUR_EYES');
    await users.ada.put('/admin/settings', { four_eyes: false });
    expect((await users.aron.post(`/declarations/${d.id}/approve`, {})).status).toBe(200);
    await waitFor(d.id, ['ACCEPTED']);
    await users.ada.put('/admin/settings', { four_eyes: true });
  });

  it('return needs a reason and goes back to the specialist; a resubmit is version 2; the submitter can recall', async () => {
    const d = await complete();
    await users.sara.post(`/declarations/${d.id}/submit`, {});
    expect((await users.aron.post(`/declarations/${d.id}/return`, {})).body.code).toBe('REASON_REQUIRED');
    const r = (await users.aron.post(`/declarations/${d.id}/return`, { reason: 'Feil leveringsvilkår' })).body;
    expect(r).toMatchObject({ status: 'RETURNED', editable: true });
    expect(r.versions[0]).toMatchObject({ decision: 'RETURNED', decision_reason: 'Feil leveringsvilkår' });
    expect(r.comments.map((c: any) => [c.user_name, c.text])).toEqual([['Aron', 'Returnert: Feil leveringsvilkår']]);
    const e = await users.sara.put(`/declarations/${d.id}`, { incoterms: 'FCA', version: r.version });
    expect(e.status).toBe(200);
    await users.sara.post(`/declarations/${d.id}/comments`, { text: 'Rettet til FCA.' });
    const s2 = (await users.sara.post(`/declarations/${d.id}/submit`, {})).body;
    expect(s2.current_version).toBe(2);
    expect(s2.comments.map((c: any) => c.text)).toEqual(['Returnert: Feil leveringsvilkår', 'Rettet til FCA.']);
    const rc = (await users.sara.post(`/declarations/${d.id}/recall`, {})).body;
    expect(rc.status).toBe('RETURNED');
    expect(rc.versions[0].decision_reason).toBe('Trukket tilbake av innsenderen');
  });

  it('a TVINN rejection is an answer: error codes on the declaration, back to the specialist, then version 2 accepted', async () => {
    const d = await complete({ own_ref: 'SIM-AVVIS 1' });
    await users.sara.post(`/declarations/${d.id}/submit`, {});
    await users.aron.post(`/declarations/${d.id}/approve`, {});
    const rej = await waitFor(d.id, ['REJECTED']);
    expect(rej.editable).toBe(true);
    expect(rej.versions[0]).toMatchObject({ result: 'REJECTED', mrn: null });
    expect(rej.versions[0].answer.errors).toEqual([expect.objectContaining({ number: '9110', box: '48', msg: 'Deklaranten har ikke den oppgitte kredittavtalen' })]);
    const fixed = (await users.sara.put(`/declarations/${d.id}`, { own_ref: 'PO-1', version: rej.version })).body;
    await users.sara.post(`/declarations/${d.id}/submit`, { version: fixed.version });
    await users.aron.post(`/declarations/${d.id}/approve`, {});
    const ok = await waitFor(d.id, ['ACCEPTED']);
    expect(ok.versions.map((v: any) => [v.version_no, v.result])).toEqual([[2, 'ACCEPTED'], [1, 'REJECTED']]);
    expect(ok.versions[0].tvinn_id).toMatch(/-2$/);
  });

  it('statistical control is rehearsed on an even sequence number over 250 000 kr', async () => {
    let d = await complete({}, 30000);
    if (Number(d.decl_no.slice(-5)) % 2 === 1) d = await complete({}, 30000);   // the next number is even
    await users.sara.post(`/declarations/${d.id}/submit`, {});
    await users.aron.post(`/declarations/${d.id}/approve`, {});
    const done = await waitFor(d.id, ['ACCEPTED']);
    expect(done.versions[0]).toMatchObject({ result: 'STAT_CHECK' });
    expect(done.versions[0].answer.decision).toBe('Tatt ut til statistisk kontroll');
  });

  it('the EDIFACT adapter never transmits: the job fails at once (no retry), and can be cancelled back to the specialist', async () => {
    process.env.TVINN_ADAPTER = 'edifact';
    const d = await complete();
    await users.sara.post(`/declarations/${d.id}/submit`, {});
    await users.aron.post(`/declarations/${d.id}/approve`, {});
    let c = await card(d.id);
    for (let i = 0; i < 40 && c.queue[0]?.status !== 'FAILED'; i++) { await new Promise(r => setTimeout(r, 100)); c = await card(d.id); }
    expect(c.queue[0]).toMatchObject({ status: 'FAILED', adapter: 'edifact', attempts: 1, last_error: expect.stringMatching(/skjelett/) });
    expect(c.status).toBe('APPROVED');
    delete process.env.TVINN_ADAPTER;
    const q = (await users.aron.get('/send-queue')).body;
    const job = q.find((j: any) => j.declaration_id === d.id);
    expect((await users.sara.post(`/send-queue/${job.id}/cancel`, {})).status).toBe(403);
    await users.aron.post(`/send-queue/${job.id}/cancel`, { reason: 'Sendes på nytt med simulatoren' });
    const back = await card(d.id);
    expect(back).toMatchObject({ status: 'RETURNED', editable: true });
    expect(back.comments.at(-1).text).toBe('Sending avbrutt: Sendes på nytt med simulatoren');
  });
});
