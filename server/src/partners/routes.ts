import { Router } from 'express';
import { z } from 'zod';
import { handle, fail } from '../errors.js';
import { need } from '../auth/guard.js';
import * as P from './repo.js';

export const partnerRoutes = Router();
const edit = need('partner.edit'), manage = need('partner.manage');

partnerRoutes.get('/partners/meta', handle(async () => ({ ...P.META, priceItems: await P.priceItems() })));
partnerRoutes.get('/partners/counters', handle(() => P.counters()));
partnerRoutes.get('/partners/lookup', handle(req => P.lookup(String(req.query.box ?? ''), String(req.query.q ?? ''))));
partnerRoutes.get('/partners/brreg/search', handle(req => P.brregSearch(String(req.query.q ?? ''))));
partnerRoutes.post('/partners/brreg/import', edit, handle(req => P.importFromBrreg(req, req.body ?? {})));
partnerRoutes.get('/partners', handle(req => P.list({ q: req.query.q as string, role: req.query.role as string, client: req.query.client as string,
  status: req.query.status as string, country: req.query.country as string })));
partnerRoutes.post('/partners', edit, handle(req => P.saveGeneral(req, { ...req.body, id: undefined })));
partnerRoutes.get('/partners/:id', handle(req => P.get(req.params.id)));
partnerRoutes.put('/partners/:id', edit, handle(req => P.saveGeneral(req, { ...req.body, id: req.params.id })));

partnerRoutes.post('/partners/:id/rows/:kind', edit, handle(req => {
  if (!P.isKind(req.params.kind)) fail(404, 'Ukjent radtype.');
  return P.saveChild(req, req.params.id, req.params.kind as any, req.body ?? {});
}));
partnerRoutes.post('/partners/:id/rows/:kind/:row/end', edit, handle(req => {
  if (!P.isKind(req.params.kind)) fail(404, 'Ukjent radtype.');
  return P.endChild(req, req.params.id, req.params.kind as any, req.params.row, req.body?.end);
}));
partnerRoutes.post('/partners/:id/relationships', edit, handle(req => P.saveRelationship(req, req.params.id, req.body ?? {})));
partnerRoutes.post('/partners/:id/relationships/:rel/end', edit, handle(req => P.endRelationship(req, req.params.id, req.params.rel)));
partnerRoutes.post('/partners/:id/fullmakt', edit, handle(req => P.saveFullmakt(req, req.params.id, req.body ?? {})));
partnerRoutes.post('/partners/:id/fullmakt/:fm/revoke', edit, handle(req => P.revokeFullmakt(req, req.params.id, req.params.fm)));
partnerRoutes.post('/partners/:id/prices', edit, handle(req => P.lockPrice(req, req.params.id, req.body ?? {})));
partnerRoutes.put('/partners/:id/invoicing', need('invoice.edit'), handle(req => P.saveInvoicing(req, req.params.id, req.body ?? {})));
partnerRoutes.post('/partners/:id/brreg/refresh', edit, handle(req => P.refreshRegistry(req, req.params.id)));
partnerRoutes.post('/partners/:id/brreg/apply', edit, handle(req => P.applyRegistry(req, req.params.id, req.body ?? {})));
partnerRoutes.post('/partners/:id/identifiers/:row/check-eori', edit, handle(req => P.checkEori(req, req.params.id, req.params.row)));
partnerRoutes.post('/partners/:id/deactivate', manage, handle(req => P.setStatus(req, req.params.id, 'INACTIVE')));
partnerRoutes.post('/partners/:id/reactivate', manage, handle(req => P.setStatus(req, req.params.id, 'ACTIVE')));
partnerRoutes.post('/partners/:id/merge', manage, handle(req => P.merge(req, req.params.id, z.object({ target: z.string() }).parse(req.body).target)));
