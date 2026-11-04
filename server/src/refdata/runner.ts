import { pool } from '../db.js';
import { DATASETS, datasetById, type Dataset } from './datasets.js';
import { liveFetchers, type Fetchers } from './fetch.js';

/** A load that would leave less than this share of the rows held now is refused (a half-published dataset). */
const SHRINK_LIMIT = 0.5;
const running = new Set<string>();

export interface RunOutcome { dataset: string; status: 'OK' | 'FAILED' | 'REFUSED' | 'BUSY'; rowsWritten?: number; message?: string }

/**
 * Load one dataset: fetch, check the mapping, replace its table(s) in one transaction, and record
 * the run in ref_sync. On any failure the previous data stays untouched.
 */
export async function runDataset(ds: Dataset, opts: { fetchers?: Fetchers; userId?: string | null } = {}): Promise<RunOutcome> {
  if (running.has(ds.id)) return { dataset: ds.id, status: 'BUSY', message: 'Oppdateres allerede.' };
  running.add(ds.id);
  const sync = (await pool.query(`INSERT INTO ref_sync (dataset, status, triggered_by) VALUES ($1, 'RUNNING', $2) RETURNING id`, [ds.id, opts.userId ?? null])).rows[0].id;
  const finish = (status: string, extra: { seen?: number; written?: number; url?: string; message?: string }) =>
    pool.query(`UPDATE ref_sync SET finished_at = now(), status = $2, rows_seen = $3, rows_written = $4, source_url = $5, message = $6 WHERE id = $1`,
      [sync, status, extra.seen ?? null, extra.written ?? null, extra.url ?? null, extra.message ?? null]);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const before = await ds.count(c);
    const r = await ds.load(opts.fetchers ?? liveFetchers, c);
    const after = await ds.count(c);
    if (before > 100 && after < before * SHRINK_LIMIT) {
      await c.query('ROLLBACK');
      const message = `Avvist: kilden ga ${after} rader, mot ${before} i dag. De gamle dataene er beholdt.`;
      await finish('REFUSED', { seen: r.rowsSeen, written: 0, url: r.url, message });
      return { dataset: ds.id, status: 'REFUSED', message };
    }
    await c.query('COMMIT');
    await finish('OK', { seen: r.rowsSeen, written: r.rowsWritten, url: r.url });
    return { dataset: ds.id, status: 'OK', rowsWritten: r.rowsWritten };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    const message = (e as Error).message;
    await finish('FAILED', { message });
    return { dataset: ds.id, status: 'FAILED', message };
  } finally {
    c.release();
    running.delete(ds.id);
  }
}

/** All datasets in order (one failing does not stop the rest). */
export async function runAll(opts: { fetchers?: Fetchers; userId?: string | null } = {}) {
  const out: RunOutcome[] = [];
  for (const ds of DATASETS) out.push(await runDataset(ds, opts));
  return out;
}

export async function runById(id: string, opts: { fetchers?: Fetchers; userId?: string | null } = {}) {
  const ds = datasetById(id);
  if (!ds) throw new Error(`Ukjent datasett: ${id}`);
  return runDataset(ds, opts);
}

export const isRunning = (id?: string) => (id ? running.has(id) : running.size > 0);

/** Per dataset: rows held now, the last successful load, and the last attempt. */
export async function status() {
  const last = (await pool.query(`SELECT DISTINCT ON (dataset) * FROM ref_sync ORDER BY dataset, started_at DESC`)).rows;
  const ok = (await pool.query(`SELECT DISTINCT ON (dataset) dataset, finished_at FROM ref_sync WHERE status = 'OK' ORDER BY dataset, started_at DESC`)).rows;
  return Promise.all(DATASETS.map(async ds => {
    const l = last.find(r => r.dataset === ds.id) ?? null;
    return {
      id: ds.id, label: ds.label, source: ds.source, rows: await ds.count(pool), running: running.has(ds.id),
      lastOkAt: ok.find(r => r.dataset === ds.id)?.finished_at ?? null,
      last: l && { status: l.status, startedAt: l.started_at, finishedAt: l.finished_at, rowsWritten: l.rows_written, message: l.message, url: l.source_url }
    };
  }));
}
