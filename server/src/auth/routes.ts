import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { handle, fail } from '../errors.js';
import { audit } from '../audit.js';
import { hash, verify, weakness } from './passwords.js';
import { start, end, revokeAllFor, type SessionUser } from './sessions.js';
import { ROLES } from './roles.js';

export const authRoutes = Router();

const me = (u: SessionUser) =>
  ({ id: u.id, email: u.email, name: u.name, roles: u.roles, perms: u.perms, lang: u.lang, mustChange: u.mustChange });

/** Before anyone signs in: does the installation still need its first administrator? */
authRoutes.get('/auth/config', handle(async () => {
  const n = (await one<{ n: number }>('SELECT COUNT(*) n FROM users'))!.n;
  const lang = await one<{ value: string }>("SELECT value FROM app_settings WHERE key = 'default_lang'");
  return { setupNeeded: n === 0, defaultLang: lang?.value ?? 'no', roles: ROLES };
}));

/** First administrator, from the login page. Refused once any user exists. */
authRoutes.post('/auth/setup', handle(async (req, res) => {
  if ((await one<{ n: number }>('SELECT COUNT(*) n FROM users'))!.n) fail(409, 'Administratoren er allerede opprettet. Logg inn.', 'SETUP_DONE');
  const b = z.object({ name: z.string().trim().min(2), email: z.string().trim().email(), password: z.string() }).parse(req.body);
  const w = weakness(b.password, b.email); if (w) fail(400, w, 'WEAK');
  const pwHash = await hash(b.password);
  // One statement: two browsers at the same moment cannot both create the first administrator.
  const u = await one(`INSERT INTO users (email, name, password_hash, roles)
      SELECT $1, $2, $3, '{admin,approver}' WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id, name`,
    [b.email, b.name, pwHash]);
  if (!u) fail(409, 'Administratoren er allerede opprettet. Logg inn.', 'SETUP_DONE');
  await audit(null, { action: 'USER_SETUP', objectType: 'USER', objectId: u.id, detail: { email: b.email } });
  await start(req, res, u.id);
  return { ok: true };
}));

authRoutes.post('/auth/login', handle(async (req, res) => {
  const b = z.object({ email: z.string().trim(), password: z.string() }).parse(req.body);
  const u = await one('SELECT * FROM users WHERE lower(email) = lower($1)', [b.email]);
  const generic = () => fail(401, 'Feil e-post eller passord.', 'LOGIN');
  if (!u || !u.active) { await audit(req, { action: 'LOGIN_FAILED', detail: { email: b.email } }); return generic(); }
  if (u.locked_until && new Date(u.locked_until) > new Date())
    fail(423, `Kontoen er låst etter for mange feil forsøk. Prøv igjen etter ${new Date(u.locked_until).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })}.`, 'LOCKED');
  if (!(await verify(b.password, u.password_hash))) {
    const fails = u.failed_logins + 1;
    const lock = fails >= config.login.maxFailures ? new Date(Date.now() + config.login.lockMinutes * 60e3) : null;
    await query('UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1', [u.id, lock ? 0 : fails, lock]);
    await audit(req, { action: lock ? 'USER_LOCKED' : 'LOGIN_FAILED', objectType: 'USER', objectId: u.id });
    return generic();
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  await start(req, res, u.id);
  req.user = { id: u.id, email: u.email, name: u.name, roles: u.roles, perms: [], lang: u.lang, mustChange: u.must_change, sessionId: '' };
  await audit(req, { action: 'LOGIN', objectType: 'USER', objectId: u.id });
  return { ok: true, mustChange: u.must_change };
}));

authRoutes.post('/auth/logout', handle(async (req, res) => { await end(req, res); return { ok: true }; }));

authRoutes.get('/auth/me', handle(async req => me(req.user!)));

authRoutes.post('/auth/password', handle(async req => {
  const b = z.object({ current: z.string(), next: z.string() }).parse(req.body);
  const u = (await one('SELECT * FROM users WHERE id = $1', [req.user!.id]))!;
  if (!(await verify(b.current, u.password_hash))) fail(400, 'Nåværende passord er feil.', 'PW_WRONG');
  const w = weakness(b.next, u.email); if (w) fail(400, w, 'WEAK');
  if (await verify(b.next, u.password_hash)) fail(400, 'Velg et annet passord enn det du har nå.', 'PW_SAME');
  await query('UPDATE users SET password_hash = $2, must_change = false, updated_at = now() WHERE id = $1', [u.id, await hash(b.next)]);
  await revokeAllFor(u.id, req.user!.sessionId);   // other devices must sign in again
  await audit(req, { action: 'PASSWORD_CHANGED', objectType: 'USER', objectId: u.id });
  return { ok: true };
}));

authRoutes.put('/me/lang', handle(async req => {
  const { lang } = z.object({ lang: z.enum(['no', 'en']) }).parse(req.body);
  await query('UPDATE users SET lang = $2 WHERE id = $1', [req.user!.id, lang]);
  return { ok: true, lang };
}));
