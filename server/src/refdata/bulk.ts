import type pg from 'pg';

/**
 * Insert many rows in few statements: multi-row VALUES in chunks that stay under
 * PostgreSQL's limit of 65,535 parameters per statement.
 */
export async function bulkInsert(c: pg.PoolClient, table: string, columns: string[], rows: unknown[][]) {
  if (!rows.length) return 0;
  const per = Math.max(1, Math.floor(60000 / columns.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params: unknown[] = [];
    const values = chunk.map(r => `(${r.map(v => { params.push(v); return `$${params.length}`; }).join(',')})`).join(',');
    await c.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`, params);
  }
  return rows.length;
}
