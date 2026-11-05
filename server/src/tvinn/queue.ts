import type pg from 'pg';
import { one, pool, query, tx } from '../db.js';
import { audit } from '../audit.js';
import { fail } from '../errors.js';
import * as sim from './simulator.js';
import * as edifact from './edifact.js';

/**
 * Send queue to TVINN (ODIN LINK src/sendqueue.js). One worker sends one version at a time through the
 * adapter: TVINN_ADAPTER=simulator (default) or edifact (an inert skeleton until phase 5).
 *  * A TVINN rejection is an answer, not a failure: the job is DONE and the declaration REJECTED.
 *  * A transport failure is retried after SEND_RETRY_SECONDS (10, 60, 300), then FAILED for a person
 *    (Administrasjon › Sendekø: try again / cancel). An error marked permanent is never retried: with the
 *    real network a timeout is no proof the declaration was not received.
 */
const RETRY = (process.env.SEND_RETRY_SECONDS || '10,60,300').split(',').map(Number).filter(n => n > 0);
export const adapterName = () => (process.env.TVINN_ADAPTER === 'edifact' ? 'edifact' : 'simulator');
let running = false, timer: NodeJS.Timeout | null = null;
/** Set by declarations/routes: the current check of a declaration (validate), to avoid an import cycle. */
let validateFn: ((id: string) => Promise<{ issues: any[] }>) | null = null;
export const setValidator = (fn: typeof validateFn) => { validateFn = fn; };

export async function enqueue(c: pg.PoolClient, declId: string, versionId: string, userId: string) {
  const active = (await c.query("SELECT 1 FROM send_queue WHERE declaration_id = $1 AND status IN ('QUEUED', 'SENDING')", [declId])).rowCount;
  if (active) fail(409, 'Deklarasjonen ligger allerede i sendekøen.', 'ALREADY_QUEUED');
  await c.query('INSERT INTO send_queue (declaration_id, version_id, adapter, queued_by) VALUES ($1, $2, $3, $4)', [declId, versionId, adapterName(), userId]);
}

export function kick(delayMs = 0) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void work().catch(e => console.error('send queue:', e)); }, delayMs);
  timer.unref?.();
}

async function work() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const j = await one("SELECT * FROM send_queue WHERE status = 'QUEUED' AND next_try_at <= now() ORDER BY queued_at LIMIT 1");
      if (!j) break;
      await runJob(j);
    }
  } finally {
    running = false;
    const next = await one("SELECT extract(epoch FROM (min(next_try_at) - now())) * 1000 ms FROM send_queue WHERE status = 'QUEUED'");
    if (next?.ms != null) kick(Math.max(200, Number(next.ms)));
  }
}

async function runJob(j: any) {
  await pool.query("UPDATE send_queue SET status = 'SENDING', started_at = now(), attempts = attempts + 1 WHERE id = $1", [j.id]);
  await pool.query("UPDATE declaration SET status = 'SENT', updated_at = now() WHERE id = $1 AND status = 'APPROVED'", [j.declaration_id]);
  const v = await one('SELECT v.*, d.decl_no FROM declaration_version v JOIN declaration d ON d.id = v.declaration_id WHERE v.id = $1', [j.version_id]);
  try {
    let answer: sim.Answer;
    if (j.adapter === 'edifact') answer = await edifact.submit();
    else {
      const current = validateFn ? await validateFn(j.declaration_id) : { issues: v.snapshot.issues ?? [] };
      answer = await sim.submit(v.snapshot, current, Number(String(v.decl_no).replace(/^.*-/, '')) || 1,
        async n => (await one('SELECT text FROM tvinn_error_code WHERE number = $1', [n]))?.text ?? null);
    }
    const status = answer.result === 'REJECTED' ? 'REJECTED' : 'ACCEPTED';
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE declaration_version SET result = $2, answer = $3, mrn = $4, tvinn_no = $5, answered_at = now() WHERE id = $1`,
        [v.id, answer.result, JSON.stringify(answer), answer.mrn, answer.tvinnNo]);
      await c.query(`UPDATE declaration SET status = $2, mrn = coalesce($3, mrn), tvinn_no = coalesce($4, tvinn_no), version = version + 1, updated_at = now() WHERE id = $1`,
        [j.declaration_id, status, answer.mrn, answer.tvinnNo]);
      await c.query("UPDATE send_queue SET status = 'DONE', finished_at = now(), last_error = NULL WHERE id = $1", [j.id]);
      await audit(null, { action: 'TVINN_ANSWER', objectType: 'DECLARATION', objectId: j.declaration_id, after: { status },
        detail: { version: v.version_no, result: answer.result, mrn: answer.mrn, tvinnNo: answer.tvinnNo, errors: answer.errors.length, adapter: j.adapter } }, c);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } catch (e: any) {
    const attempts = j.attempts + 1, message = String(e?.message ?? e).slice(0, 500);
    // The job and the declaration change together, so nobody ever sees one without the other.
    await tx(async c => {
      await c.query("UPDATE declaration SET status = 'APPROVED', updated_at = now() WHERE id = $1 AND status = 'SENT'", [j.declaration_id]);
      if (e?.permanent || attempts > RETRY.length) {
        await c.query("UPDATE send_queue SET status = 'FAILED', last_error = $2, finished_at = now() WHERE id = $1", [j.id, message]);
        await audit(null, { action: 'TVINN_SEND_FAILED', objectType: 'DECLARATION', objectId: j.declaration_id, detail: { job: j.id, attempts, error: message } }, c);
      } else {
        await c.query("UPDATE send_queue SET status = 'QUEUED', last_error = $2, next_try_at = now() + make_interval(secs => $3) WHERE id = $1", [j.id, message, RETRY[attempts - 1]]);
      }
    });
  }
}

/** Administrasjon › Sendekø. */
export const list = () => query(`SELECT q.*, d.decl_no, v.version_no, u.name queued_by_name FROM send_queue q JOIN declaration d ON d.id = q.declaration_id
    JOIN declaration_version v ON v.id = q.version_id LEFT JOIN users u ON u.id = q.queued_by ORDER BY q.queued_at DESC LIMIT 300`);

export async function retry(req: any, id: string) {
  const j = await one('SELECT * FROM send_queue WHERE id = $1', [id]);
  if (!j) fail(404, 'Fant ikke jobben.');
  if (j.status !== 'FAILED') fail(409, 'Bare en feilet jobb kan prøves igjen.');
  if (await one("SELECT 1 FROM send_queue WHERE declaration_id = $1 AND status IN ('QUEUED', 'SENDING')", [j.declaration_id])) fail(409, 'Deklarasjonen ligger allerede i køen.');
  await pool.query("UPDATE send_queue SET status = 'QUEUED', attempts = 0, next_try_at = now(), finished_at = NULL, adapter = $2 WHERE id = $1", [id, adapterName()]);
  await audit(req, { action: 'TVINN_SEND_RETRY', objectType: 'DECLARATION', objectId: j.declaration_id, detail: { job: id } });
  kick();
}

/** Cancel a job that waits or failed: the declaration goes back to the specialist as returned. */
export async function cancel(req: any, id: string, reason: unknown) {
  const j = await one('SELECT * FROM send_queue WHERE id = $1', [id]);
  if (!j) fail(404, 'Fant ikke jobben.');
  if (!['QUEUED', 'FAILED'].includes(j.status)) fail(409, 'Bare en jobb som venter eller har feilet, kan avbrytes.');
  const why = String(reason ?? '').trim() || 'Sendingen ble avbrutt';
  await pool.query("UPDATE send_queue SET status = 'CANCELLED', finished_at = now() WHERE id = $1", [id]);
  await pool.query("UPDATE declaration SET status = 'RETURNED', version = version + 1, updated_at = now() WHERE id = $1 AND status IN ('APPROVED', 'SENT')", [j.declaration_id]);
  await pool.query('INSERT INTO declaration_comment (declaration_id, user_id, text) VALUES ($1, $2, $3)', [j.declaration_id, req.user.id, `Sending avbrutt: ${why}`]);
  await audit(req, { action: 'TVINN_SEND_CANCELLED', objectType: 'DECLARATION', objectId: j.declaration_id, detail: { job: id, reason: why } });
}

/** At start-up: jobs cut off while sending are queued again (the simulator is safe to repeat). */
export async function start() {
  await pool.query("UPDATE send_queue SET status = 'QUEUED', next_try_at = now() WHERE status = 'SENDING' AND adapter = 'simulator'");
  await pool.query("UPDATE send_queue SET status = 'FAILED', last_error = 'Avbrutt under sending. Kontroller hos Tolletaten før du prøver igjen.', finished_at = now() WHERE status = 'SENDING'");
  kick(1000);
}
