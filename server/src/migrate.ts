import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { pool } from './db.js';

const DIR = path.join(ROOT, 'server', 'migrations');

/**
 * Apply every migrations/*.sql not applied yet, in name order, each in its own transaction.
 * A migration that was changed after it ran is reported, never re-run: write a new one instead.
 */
export async function migrate(): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  const done = new Map((await pool.query('SELECT filename, checksum FROM schema_migrations')).rows.map(r => [r.filename, r.checksum]));
  const applied: string[] = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    if (done.has(f)) {
      if (done.get(f) !== sum) console.warn(`Warning: migration ${f} was changed after it ran. Add a new migration instead.`);
      continue;
    }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [f, sum]);
      await c.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await c.query('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  return applied;
}
