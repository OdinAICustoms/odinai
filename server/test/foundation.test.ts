import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../src/db.js';
import { app, client, freshDb, PW } from './helpers.js';

beforeAll(freshDb);
afterAll(() => pool.end());

describe('first administrator', () => {
  it('a new installation asks for its first administrator', async () => {
    const r = await client().get('/auth/config');
    expect(r.status).toBe(200);
    expect(r.body.setupNeeded).toBe(true);
  });
  it('refuses a weak password', async () => {
    const r = await client().post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: 'kort1' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('WEAK');
  });
  it('creates the administrator, signs in, and refuses a second setup', async () => {
    const c = client();
    expect((await c.post('/auth/setup', { name: 'Ada Admin', email: 'ada@odin.test', password: PW })).status).toBe(200);
    const me = await c.get('/auth/me');
    expect(me.body.roles).toEqual(['admin', 'approver']);
    expect(me.body.perms).toContain('users.manage');
    expect((await client().post('/auth/setup', { name: 'X', email: 'x@odin.test', password: PW })).status).toBe(409);
  });
});

describe('sign-in and sessions', () => {
  it('rejects a write without the X-OdinAi header (CSRF)', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'ada@odin.test', password: PW });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CSRF');
  });
  it('wrong password gives one generic message; five in a row lock the account', async () => {
    await pool.query("INSERT INTO users (email, name, password_hash) SELECT 'lock@odin.test', 'Lars Lås', password_hash FROM users WHERE email = 'ada@odin.test'");
    for (let i = 0; i < 5; i++) {
      const r = await client().post('/auth/login', { email: 'lock@odin.test', password: 'feil-passord-1' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Feil e-post eller passord.');
    }
    const locked = await client().post('/auth/login', { email: 'lock@odin.test', password: PW });
    expect(locked.status).toBe(423);
  });
  it('an unknown e-mail gets the same answer as a wrong password', async () => {
    const r = await client().post('/auth/login', { email: 'nobody@odin.test', password: PW });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Feil e-post eller passord.');
  });
  it('logout ends the session', async () => {
    const c = client();
    await c.post('/auth/login', { email: 'ada@odin.test', password: PW });
    expect((await c.get('/auth/me')).status).toBe(200);
    await c.post('/auth/logout');
    expect((await c.get('/auth/me')).status).toBe(401);
  });
  it('the cookie value is never stored, only its hash', async () => {
    const c = client();
    const r = await c.post('/auth/login', { email: 'ada@odin.test', password: PW });
    const cookie = String(r.headers['set-cookie']).match(/odinai_sid=([^;]+)/)![1];
    const hit = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [cookie]);
    expect(hit.rowCount).toBe(0);
  });
});

describe('users and roles', () => {
  let temp = '', userId = '';
  it('administrator creates a specialist with a temporary password', async () => {
    const c = client(); await c.post('/auth/login', { email: 'ada@odin.test', password: PW });
    const r = await c.post('/admin/users', { name: 'Sara Spesialist', email: 'sara@odin.test', roles: ['specialist'] });
    expect(r.status).toBe(200);
    expect(r.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    temp = r.body.temporaryPassword; userId = r.body.user.id;
    expect((await c.post('/admin/users', { name: 'Sara', email: 'SARA@odin.test', roles: ['specialist'] })).status).toBe(409);
    expect((await c.post('/admin/users', { name: 'Ukjent', email: 'u@odin.test', roles: ['king'] })).status).toBe(400);
  });
  it('the new user must change the password before doing anything else', async () => {
    const c = client();
    const r = await c.post('/auth/login', { email: 'sara@odin.test', password: temp });
    expect(r.body.mustChange).toBe(true);
    expect((await c.get('/admin/settings')).body.code).toBe('PW_CHANGE');
    expect((await c.post('/auth/password', { current: temp, next: 'sara2026passord' })).body.code).toBe('WEAK');
    expect((await c.post('/auth/password', { current: temp, next: PW })).status).toBe(200);
    expect((await c.get('/admin/settings')).status).toBe(200);
  });
  it('a specialist cannot manage users or settings', async () => {
    const c = client(); await c.post('/auth/login', { email: 'sara@odin.test', password: PW });
    const me = (await c.get('/auth/me')).body;
    expect(me.perms).toContain('product.check');           // decided 2026-11-04: everyone may check products
    expect(me.perms).not.toContain('declaration.approve');
    expect((await c.get('/admin/users')).status).toBe(403);
    expect((await c.put('/admin/settings', { four_eyes: false })).status).toBe(403);
  });
  it('the last active administrator cannot be removed', async () => {
    const c = client(); await c.post('/auth/login', { email: 'ada@odin.test', password: PW });
    const ada = (await c.get('/auth/me')).body.id;
    const r = await c.put(`/admin/users/${ada}`, { roles: ['specialist'] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LAST_ADMIN');
  });
  it('deactivating a user ends their sessions', async () => {
    const sara = client(); await sara.post('/auth/login', { email: 'sara@odin.test', password: PW });
    const ada = client(); await ada.post('/auth/login', { email: 'ada@odin.test', password: PW });
    expect((await ada.put(`/admin/users/${userId}`, { active: false })).status).toBe(200);
    expect((await sara.get('/auth/me')).status).toBe(401);
    expect((await client().post('/auth/login', { email: 'sara@odin.test', password: PW })).status).toBe(401);
  });
});

describe('settings and audit log', () => {
  it('four eyes is on by default and an administrator can switch it off', async () => {
    const c = client(); await c.post('/auth/login', { email: 'ada@odin.test', password: PW });
    expect((await c.get('/admin/settings')).body.four_eyes).toBe(true);
    expect((await c.put('/admin/settings', { four_eyes: false })).body.four_eyes).toBe(false);
    expect((await c.put('/admin/settings', { unknown: 1 })).status).toBe(400);
  });
  it('every step is in the audit log, field by field, without passwords', async () => {
    const c = client(); await c.post('/auth/login', { email: 'ada@odin.test', password: PW });
    const log = (await c.get('/admin/audit?limit=200')).body as any[];
    const actions = new Set(log.map(r => r.action));
    for (const a of ['USER_SETUP', 'LOGIN', 'LOGIN_FAILED', 'USER_LOCKED', 'USER_CREATED', 'PASSWORD_CHANGED', 'USER_CHANGED', 'SETTING_CHANGED']) expect(actions).toContain(a);
    const change = log.find(r => r.action === 'USER_CHANGED' && r.changes?.active);
    expect(change.changes.active).toEqual([true, false]);
    expect(JSON.stringify(log)).not.toContain(PW);
    const setting = log.find(r => r.action === 'SETTING_CHANGED');
    expect(setting.changes.value).toEqual([true, false]);
  });
  it('the audit log cannot be changed or emptied', async () => {
    await expect(pool.query('UPDATE audit_log SET action = $1', ['X'])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});
