import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
};

export const config = {
  port: Number(process.env.PORT || 3200),
  production: process.env.NODE_ENV === 'production',
  databaseUrl: required('DATABASE_URL'),
  fileStore: path.resolve(ROOT, process.env.FILE_STORE || './data/files'),
  session: {
    cookie: 'odinai_sid',
    ttlHours: Number(process.env.SESSION_TTL_HOURS || 12),     // absolute lifetime
    idleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 120)
  },
  login: { maxFailures: 5, lockMinutes: 15, minPasswordLength: 12 }
};
