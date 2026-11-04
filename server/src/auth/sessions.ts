import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { ipOf } from '../audit.js';
import { permsOf } from './roles.js';

export interface SessionUser {
  id: string; email: string; name: string; roles: string[]; perms: string[]; lang: string; mustChange: boolean; sessionId: string;
}
declare module 'express-serve-static-core' {
  interface Request { user?: SessionUser }
}

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/** New session: a random cookie value; only its hash is stored. */
export async function start(req: Request, res: Response, userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.session.ttlHours * 3600e3);
  await query(`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [sha(token), userId, expires, ipOf(req), String(req.get('user-agent') || '').slice(0, 300)]);
  res.cookie(config.session.cookie, token, { httpOnly: true, sameSite: 'lax', secure: config.production, expires, path: '/' });
}

export async function end(req: Request, res: Response) {
  const token = req.cookies?.[config.session.cookie];
  if (token) await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sha(token)]);
  res.clearCookie(config.session.cookie, { path: '/' });
}

/** The signed-in user for this request, or null (expired, idle too long, revoked, user inactive). */
export async function resolve(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[config.session.cookie];
  if (!token) return null;
  const id = sha(token);
  const r = await one(`SELECT s.id sid, s.last_seen, s.expires_at, s.revoked_at, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [id]);
  if (!r || r.revoked_at || !r.active) return null;
  const now = Date.now();
  if (new Date(r.expires_at).getTime() < now || new Date(r.last_seen).getTime() + config.session.idleMinutes * 60e3 < now) return null;
  // Touch at most once a minute.
  if (now - new Date(r.last_seen).getTime() > 60e3) await query('UPDATE sessions SET last_seen = now() WHERE id = $1', [id]);
  return { id: r.id, email: r.email, name: r.name, roles: r.roles, perms: permsOf(r.roles), lang: r.lang, mustChange: r.must_change, sessionId: id };
}

export const revokeAllFor = (userId: string, exceptSessionId?: string) =>
  query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2', [userId, exceptSessionId ?? '']);
