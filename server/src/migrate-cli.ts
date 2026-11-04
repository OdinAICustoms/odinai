import { migrate } from './migrate.js';
import { pool } from './db.js';

const applied = await migrate();
console.log(applied.length ? `Migrations applied: ${applied.join(', ')}` : 'Database is up to date.');
await pool.end();
