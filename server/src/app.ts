import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { ROOT, config } from './config.js';
import { pool } from './db.js';
import { guard } from './auth/guard.js';
import { authRoutes } from './auth/routes.js';
import { adminRoutes } from './admin/routes.js';
import { refdataRoutes } from './refdata/routes.js';
import { partnerRoutes } from './partners/routes.js';
import { productRoutes } from './products/routes.js';
import { errorHandler } from './errors.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"]
    } }
  }));
  app.use(express.json({ limit: '40mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use('/auth/login', rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false }));
  api.use(rateLimit({ windowMs: 60e3, limit: 1200, standardHeaders: true, legacyHeaders: false }));
  api.get('/health', async (_req, res) => {
    let db = false;
    try { db = (await pool.query('SELECT 1 ok')).rows[0].ok === 1; } catch { /* reported below */ }
    res.status(db ? 200 : 503).json({ ok: db, version: process.env.npm_package_version || '0.1.0' });
  });
  api.use(guard);
  api.use(authRoutes);
  api.use(adminRoutes);
  api.use(refdataRoutes);
  api.use(productRoutes);   // before partnerRoutes: /partners/:id/products and /rt-permits live here
  api.use(partnerRoutes);
  api.use((_req, res) => res.status(404).json({ error: 'Ukjent adresse', code: 'NOT_FOUND' }));
  app.use('/api', api);

  // The built screens (npm run build). In development Vite serves them on its own port.
  const dist = path.join(ROOT, 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, setHeaders: r => r.setHeader('Cache-Control', 'no-cache') }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}

export { config };
