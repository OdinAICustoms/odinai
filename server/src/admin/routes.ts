import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db.js';
import { handle, fail } from '../errors.js';
import { audit } from '../audit.js';
import { need } from '../auth/guard.js';
import { hash, temporary } from '../auth/passwords.js';
import { revokeAllFor } from '../auth/sessions.js';
import { isRole } from '../auth/roles.js';

export const adminRoutes = Router();
const USER_COLS = 'id, email, name, roles, lang, active, must_change, last_login_at, locked_until, created_at';
const roles = z.array(z.string()).min(1).refine(a => a.every(isRole), 'Ukjent rolle');

/* ------------------------------ users ------------------------------ */
adminRoutes.get('/admin/users', need('users.manage'), handle(() => query(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, name`)));

/** New user with a temporary password, shown once to the administrator; changed at first login. */
adminRoutes.post('/admin/users', need('users.manage'), handle(async req => {
  const b = z.object({ name: z.string().trim().min(2), email: z.string().trim().email(), roles }).parse(req.body);
  if (await one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email])) fail(409, 'En bruker med denne e-postadressen finnes allerede.', 'EXISTS');
  const pw = temporary();
  const u = (await one(`INSERT INTO users (email, name, password_hash, roles, must_change) VALUES ($1, $2, $3, $4, true) RETURNING ${USER_COLS}`,
    [b.email, b.name, await hash(pw), b.roles]))!;
  await audit(req, { action: 'USER_CREATED', objectType: 'USER', objectId: u.id, after: { email: u.email, name: u.name, roles: u.roles } });
  return { user: u, temporaryPassword: pw };
}));

adminRoutes.put('/admin/users/:id', need('users.manage'), handle(async req => {
  const b = z.object({ name: z.string().trim().min(2).optional(), roles: roles.optional(), active: z.boolean().optional() }).parse(req.body);
  const before = await one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.params.id]);
  if (!before) fail(404, 'Fant ikke brukeren.');
  // Never leave the installation without an active administrator.
  const losesAdmin = (b.active === false || (b.roles && !b.roles.includes('admin'))) && before!.roles.includes('admin');
  if (losesAdmin) {
    const others = (await one<{ n: number }>("SELECT COUNT(*) n FROM users WHERE active AND 'admin' = ANY(roles) AND id <> $1", [req.params.id]))!.n;
    if (!others) fail(409, 'Det må finnes minst én aktiv administrator.', 'LAST_ADMIN');
  }
  const after = (await one(`UPDATE users SET name = COALESCE($2, name), roles = COALESCE($3, roles), active = COALESCE($4, active), updated_at = now()
      WHERE id = $1 RETURNING ${USER_COLS}`, [req.params.id, b.name ?? null, b.roles ?? null, b.active ?? null]))!;
  if (b.active === false) await revokeAllFor(after.id);
  await audit(req, { action: 'USER_CHANGED', objectType: 'USER', objectId: after.id, before, after });
  return after;
}));

adminRoutes.post('/admin/users/:id/reset-password', need('users.manage'), handle(async req => {
  const u = await one('SELECT id FROM users WHERE id = $1', [req.params.id]);
  if (!u) fail(404, 'Fant ikke brukeren.');
  const pw = temporary();
  await query('UPDATE users SET password_hash = $2, must_change = true, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [u!.id, await hash(pw)]);
  await revokeAllFor(u!.id);
  await audit(req, { action: 'PASSWORD_RESET', objectType: 'USER', objectId: u!.id });
  return { temporaryPassword: pw };
}));

/* ------------------------------ settings ------------------------------ */
const SETTINGS = { four_eyes: z.boolean(), default_lang: z.enum(['no', 'en']) } as const;
adminRoutes.get('/admin/settings', handle(async () =>
  Object.fromEntries((await query('SELECT key, value FROM app_settings')).map(r => [r.key, r.value]))));
adminRoutes.put('/admin/settings', need('settings.edit'), handle(async req => {
  const b = z.object({ four_eyes: SETTINGS.four_eyes.optional(), default_lang: SETTINGS.default_lang.optional() }).strict().parse(req.body);
  for (const [k, v] of Object.entries(b)) {
    const before = await one('SELECT value FROM app_settings WHERE key = $1', [k]);
    await query(`INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [k, JSON.stringify(v), req.user!.id]);
    await audit(req, { action: 'SETTING_CHANGED', objectType: 'SETTING', objectId: k, before: { value: before?.value ?? null }, after: { value: v } });
  }
  return Object.fromEntries((await query('SELECT key, value FROM app_settings')).map(r => [r.key, r.value]));
}));

/* ------------------------------ audit log ------------------------------ */
adminRoutes.get('/admin/audit', need('audit.read'), handle(async req => {
  const q = z.object({ objectType: z.string().optional(), objectId: z.string().optional(), userId: z.string().uuid().optional(),
    action: z.string().optional(), before: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(500).default(100) }).parse(req.query);
  const where: string[] = [], p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  if (q.objectType) add('object_type = ?', q.objectType);
  if (q.objectId) add('object_id = ?', q.objectId);
  if (q.userId) add('user_id = ?', q.userId);
  if (q.action) add('action = ?', q.action);
  if (q.before) add('id < ?', q.before);
  p.push(q.limit);
  return query(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${p.length}`, p);
}));
