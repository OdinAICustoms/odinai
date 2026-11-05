import { Router } from 'express';
import { z } from 'zod';
import { handle, fail } from '../errors.js';
import { need } from '../auth/guard.js';
import * as docs from '../documents.js';
import { one } from '../db.js';
import * as P from './repo.js';
import * as RT from './rt.js';

export const productRoutes = Router();
const edit = need('product.edit');
const q = (req: any) => Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));

productRoutes.get('/products/meta', handle(() => ({ statuses: P.STATUSES, idTypes: P.ID_TYPES, bases: P.BASES })));
productRoutes.get('/products/worklists', handle(() => P.worklists()));
productRoutes.get('/products', handle(req => P.list(q(req))));
productRoutes.post('/products', edit, handle(req => P.create(req, req.body ?? {})));
productRoutes.get('/products/:id', handle(req => P.card(req.params.id)));
productRoutes.put('/products/:id', edit, handle(req => P.update(req, req.params.id, req.body ?? {})));
productRoutes.post('/products/:id/status', edit, handle(req => P.setStatus(req, req.params.id, req.body ?? {})));
productRoutes.post('/products/:id/identifiers', edit, handle(req => P.addIdentifier(req, req.params.id, req.body ?? {})));
productRoutes.post('/products/:id/identifiers/:ident/remove', edit, handle(req => P.removeIdentifier(req, req.params.id, req.params.ident)));
productRoutes.post('/products/:id/deactivate', edit, handle(req => P.setActive(req, req.params.id, false)));
productRoutes.post('/products/:id/reactivate', edit, handle(req => P.setActive(req, req.params.id, true)));
productRoutes.post('/products/:id/merge', need('product.check'), handle(req => P.merge(req, req.params.id, z.object({ target: z.string() }).parse(req.body).target)));
productRoutes.post('/products/:id/documents', edit, handle(async req => {
  await P.card(req.params.id);
  await docs.store(req, { type: 'PRODUCT', id: req.params.id }, req.body ?? {});
  return { product: await P.card(req.params.id), warnings: [] };
}));
productRoutes.get('/products/:id/rt-renewal', handle(async req => (await RT.renewalDefaults(req.params.id)) ?? {}));

/* RT permits — the same records from the product card, the client card and the RT list. */
productRoutes.get('/rt-permits', handle(req => RT.list(q(req))));
productRoutes.get('/rt-permits/expiring', handle(req => RT.expiring(Number(req.query.days) || 90)));
productRoutes.post('/rt-permits', edit, handle(req => RT.create(req, req.body ?? {})));
productRoutes.get('/rt-permits/:id', handle(req => RT.get(req.params.id)));
productRoutes.put('/rt-permits/:id', edit, handle(req => RT.update(req, req.params.id, req.body ?? {})));
productRoutes.post('/rt-permits/:id/withdraw', edit, handle(req => RT.deactivate(req, req.params.id, req.body?.reason)));
productRoutes.post('/rt-permits/:id/link', edit, handle(req => RT.linkToProduct(req, req.params.id, z.object({ productId: z.string() }).parse(req.body).productId)));
productRoutes.post('/rt-permits/:id/documents', edit, handle(async req => {
  await RT.get(req.params.id);
  await docs.store(req, { type: 'RT_PERMIT', id: req.params.id }, { docCode: 'RT01', ...(req.body ?? {}) });
  return { permit: await RT.get(req.params.id), warnings: [] };
}));

/** Create a draft product from a permit that has none, and link them. */
productRoutes.post('/rt-permits/:id/create-product', edit, handle(async req => {
  const r = await RT.get(req.params.id);
  if (r.product_id) fail(409, 'Tillatelsen hører allerede til et produkt.', 'RT_HAS_PRODUCT');
  const ids = [r.gtin && /^\d{8,14}$/.test(String(r.gtin).replace(/\D/g, '')) && { type: 'GTIN', value: r.gtin, source: 'RT' },
    r.sku && { type: 'CLIENT_ART', value: r.sku, partner_id: r.holder_id, source: 'RT' }].filter(Boolean);
  let made;
  try { made = await P.create(req, { name: r.product_name, descr: r.product_name, code: r.tariff_code, owner_id: r.holder_id, identifiers: ids, notes: 'Opprettet fra RT-tillatelse' }, 'RT'); }
  catch (e: any) {
    if (e?.code !== 'IDENTIFIER_TAKEN') throw e;      // an identifier belongs to another product: create without it
    made = await P.create(req, { name: r.product_name, descr: r.product_name, code: r.tariff_code, owner_id: r.holder_id, notes: 'Opprettet fra RT-tillatelse' }, 'RT');
  }
  const linked = await RT.linkToProduct(req, r.id, made.product.id);
  return { ...linked, product: await P.card(made.product.id) };
}));

/* For the client card. */
productRoutes.get('/partners/:id/products', handle(req => P.list({ owner: req.params.id, inactive: req.query.inactive ? '1' : undefined })));
productRoutes.get('/partners/:id/rt-permits', handle(async req => ({
  permits: await RT.forHolder(req.params.id),
  missing: await P.list({ owner: req.params.id, rt: 'missing' })
})));

/* Documents (any owner). */
productRoutes.get('/documents/:id', async (req, res, next) => {
  try {
    const d = await docs.read(req.params.id);
    if (!d || d.removed_at) return res.status(404).json({ error: 'Fant ikke dokumentet.' });
    if (!d.intact) return res.status(500).json({ error: 'Den lagrede filen besto ikke integritetskontrollen.' });
    const inline = req.query.inline === '1' && /^(application\/pdf|image\/)/.test(d.mime || '');
    res.setHeader('Content-Type', d.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(d.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(d.buffer);
  } catch (e) { next(e); }
});
productRoutes.post('/documents/:id/remove', edit, handle(async req => {
  const d = await one('SELECT owner_type FROM document WHERE id = $1', [req.params.id]);
  if (!d) fail(404, 'Fant ikke dokumentet.');
  if (d.owner_type === 'INVOICE') fail(409, 'Fakturaens PDF er en del av den utstedte fakturaen og kan ikke fjernes.', 'INVOICE_DOCUMENT');
  return docs.remove(req, req.params.id);
}));
