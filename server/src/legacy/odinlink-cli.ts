import { pool } from '../db.js';
import { migrate } from '../migrate.js';
import { importOdinLink, formatReport } from './odinlink.js';

/**
 * npm run import:odinlink -w server -- [--db <odin-link.db>] [--files <files dir>] [--commit] [--json]
 * Without --commit it is a dry run: the report is printed and nothing is saved.
 */
const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = val('--db') ?? process.env.ODIN_LINK_DB ?? 'C:\\ODIN LINK TEST\\data\\odin-link.db';
try {
  await migrate();
  const r = await importOdinLink({ dbPath, filesDir: val('--files'), commit: args.includes('--commit') });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
} catch (e) {
  console.error('Flyttingen stoppet, ingenting er lagret:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
