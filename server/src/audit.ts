import type { Request } from 'express';
import { pool, type Db } from './db.js';

/** Fields that are never written to the log, even as "changed". */
const SECRET = new Set(['password', 'password_hash', 'token']);

/** Field-by-field difference: { field: [before, after] } for every field that changed. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const out: Record<string, [unknown, unknown]> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    if (SECRET.has(k) || k === 'updated_at') continue;
    const a = before?.[k] ?? null, b = after?.[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = SECRET.has(k) ? ['***', '***'] : [a, b];
  }
  return out;
}

export interface AuditEntry {
  action: string;
  objectType?: string;
  objectId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  detail?: Record<string, unknown>;
}

/** Append one entry. The table refuses updates and deletes (migration 001). */
export async function audit(req: Request | null, e: AuditEntry, db: Db = pool) {
  const changes = e.before !== undefined || e.after !== undefined ? diff(e.before ?? null, e.after ?? null) : null;
  await db.query(
    `INSERT INTO audit_log (user_id, user_name, action, object_type, object_id, changes, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [req?.user?.id ?? null, req?.user?.name ?? null, e.action, e.objectType ?? null, e.objectId ?? null,
      changes && Object.keys(changes).length ? JSON.stringify(changes) : null, e.detail ? JSON.stringify(e.detail) : null, req ? ipOf(req) : null]);
}

export const ipOf = (req: Request) => String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
