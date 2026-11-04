import request from 'supertest';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/app.js';

/** Empty test database with every migration applied. */
export async function freshDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

export const app = createApp();

/** A browser-like client: keeps the session cookie and sends the X-OdinAi header on writes. */
export function client() {
  const agent = request.agent(app);
  const w = (r: request.Test) => r.set('X-OdinAi', '1');
  return {
    agent,
    get: (p: string) => agent.get('/api' + p),
    post: (p: string, body?: object) => w(agent.post('/api' + p)).send(body ?? {}),
    put: (p: string, body?: object) => w(agent.put('/api' + p)).send(body ?? {})
  };
}

export const PW = 'Riktig-Passord-2026';
