import { Router } from 'express';
import { z } from 'zod';
import { handle } from '../errors.js';
import { need } from '../auth/guard.js';
import * as D from './repo.js';

export const declarationRoutes = Router();
const read = need('declaration.read');
const edit = need('declaration.edit');
const q = (req: any) => Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));

declarationRoutes.get('/declarations/meta', read, handle(() => D.meta()));
declarationRoutes.get('/declarations', read, handle(req => D.list({ ...q(req), user: req.user!.id })));
declarationRoutes.post('/declarations', edit, handle(req => D.create(req, req.body ?? {})));
declarationRoutes.get('/declarations/:id', read, handle(req => D.card(req.params.id)));
declarationRoutes.put('/declarations/:id', edit, handle(req => D.update(req, req.params.id, req.body ?? {})));
declarationRoutes.get('/declarations/:id/check', read, handle(req => D.validate(req.params.id)));
declarationRoutes.get('/declarations/:id/payment-options', read, handle(req => D.paymentOptions(req.params.id)));
declarationRoutes.post('/declarations/:id/cancel', edit, handle(req => D.cancel(req, req.params.id, req.body?.reason, req.body?.version)));
declarationRoutes.post('/declarations/:id/copy', edit, handle(req => D.copy(req, req.params.id)));
declarationRoutes.post('/declarations/:id/documents', edit, handle(async req => {
  await D.storeDocument(req, req.params.id, req.body ?? {});
  return D.card(req.params.id);
}));

declarationRoutes.post('/declarations/:id/items', edit, handle(req => D.addItem(req, req.params.id, req.body ?? {})));
declarationRoutes.post('/declarations/:id/items/bulk', edit, handle(req => D.bulkItems(req, req.params.id, req.body ?? {})));
declarationRoutes.put('/declarations/:id/items/:item', edit, handle(req => D.updateItem(req, req.params.id, req.params.item, req.body ?? {})));
declarationRoutes.post('/declarations/:id/items/:item/remove', edit, handle(req => D.removeItem(req, req.params.id, req.params.item, req.body?.version)));
declarationRoutes.post('/declarations/:id/items/:item/move', edit, handle(req =>
  D.moveItem(req, req.params.id, req.params.item, z.object({ to: z.coerce.number().int() }).parse(req.body ?? {}).to, req.body?.version)));
