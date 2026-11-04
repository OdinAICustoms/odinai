import pg from 'pg';
import { config } from './config.js';

// numeric and bigint arrive as strings unless told otherwise; amounts stay exact as strings,
// counts (bigint from COUNT(*)) become numbers.
pg.types.setTypeParser(20, v => Number(v));
// A date column stays the text "YYYY-MM-DD": as a JavaScript Date it is local midnight, and
// toISOString() then gives the day before in Norway (UTC+1/+2).
pg.types.setTypeParser(1082, v => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const r = await db.query<T>(sql, params);
  return r.rows;
}
export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] ?? null;
}

/** Run fn in one transaction; rolled back if it throws. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
