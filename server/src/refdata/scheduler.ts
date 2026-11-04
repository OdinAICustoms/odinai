import { pool } from '../db.js';
import { runAll } from './runner.js';

/**
 * Daily refresh at REFRESH_AT (local time, default 05:30), and once at start-up when the data is
 * missing or more than a day old. REFRESH_SCHEDULE=off switches it off (tests, offline work).
 */
export function startScheduler() {
  if (/^(off|0|false|no)$/i.test(process.env.REFRESH_SCHEDULE || '')) return;
  const [hh, mm] = String(process.env.REFRESH_AT || '05:30').split(':').map(Number);
  const run = async (why: string) => {
    console.log(`Reference data: refresh (${why})`);
    const out = await runAll();
    console.log('Reference data: ' + out.map(o => `${o.dataset} ${o.status}${o.message ? ` (${o.message.slice(0, 80)})` : ''}`).join(', '));
    // Products whose valid-to passed, or whose code left the tariff, must be checked again.
    try { const n = await (await import('../products/repo.js')).expireCheck(); if (n) console.log(`Products: ${n} set to EXPIRED`); }
    catch (e) { console.warn('Product expiry check:', (e as Error).message); }
  };
  const next = () => {
    const now = new Date(), t = new Date(now);
    t.setHours(hh || 5, mm || 30, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    setTimeout(() => run('daily').finally(next), t.getTime() - now.getTime());
  };
  next();
  pool.query(`SELECT MAX(finished_at) t FROM ref_sync WHERE status = 'OK'`).then(r => {
    const t = r.rows[0]?.t as Date | null;
    if (!t || Date.now() - t.getTime() > 24 * 3600e3) setTimeout(() => run(t ? 'older than a day' : 'never loaded'), 5000);
  }).catch(() => { /* the database is reported elsewhere */ });
}
