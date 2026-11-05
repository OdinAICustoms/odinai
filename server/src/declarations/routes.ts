import { Router } from 'express';
import { z } from 'zod';
import { handle, fail } from '../errors.js';
import { need } from '../auth/guard.js';
import * as D from './repo.js';
import * as AI from '../ai/intake.js';
import * as W from './workflow.js';
import * as Q from '../tvinn/queue.js';

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

/* Submit, approval and TVINN (phase 2d). */
Q.setValidator(D.validate);
declarationRoutes.post('/declarations/:id/submit', edit, handle(req => W.submit(req, req.params.id, req.body?.version)));
declarationRoutes.post('/declarations/:id/recall', edit, handle(req => W.giveBack(req, req.params.id, req.body?.reason, true)));
declarationRoutes.post('/declarations/:id/approve', need('declaration.approve'), handle(req => W.approve(req, req.params.id)));
declarationRoutes.post('/declarations/:id/return', need('declaration.approve'), handle(req => W.giveBack(req, req.params.id, req.body?.reason)));
declarationRoutes.post('/declarations/:id/comments', read, handle(req => W.comment(req, req.params.id, req.body?.text)));
declarationRoutes.get('/declarations/:id/versions/:no/message', read, async (req, res, next) => {
  try {
    const m = await W.message(req.params.id, Number(req.params.no));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${m.tvinn_id}.edi"`);
    res.send(m.message);
  } catch (e) { next(e); }
});
declarationRoutes.get('/send-queue', need('declaration.read'), handle(() => Q.list()));
declarationRoutes.post('/send-queue/:id/retry', need('declaration.approve'), handle(async req => { await Q.retry(req, req.params.id); return Q.list(); }));
declarationRoutes.post('/send-queue/:id/cancel', need('declaration.approve'), handle(async req => { await Q.cancel(req, req.params.id, req.body?.reason); return Q.list(); }));

/* AI intake (phase 2c). */
declarationRoutes.get('/ai/status', read, handle(() => AI.status()));
/** New declaration from documents: create the draft, store the files, start the AI reading. */
declarationRoutes.post('/declarations/ai', edit, handle(async req => {
  const b = req.body ?? {};
  const files: any[] = Array.isArray(b.files) ? b.files : [];
  if (!files.length) fail(400, 'Last opp minst ett dokument (faktura, pakkliste …).', 'NO_DOCUMENTS');
  if (!AI.status().configured) fail(503, 'AI-tjenesten er ikke satt opp (ANTHROPIC_API_KEY mangler i .env).', 'AI_OFF');
  const d = await D.create(req, { importer_id: b.importer_id, own_ref: b.own_ref, decl_type: b.decl_type }, 'AI');
  for (const f of files) await D.storeDocument(req, d.id, f);
  await AI.start(req, d.id);
  return D.card(d.id);
}));
declarationRoutes.post('/declarations/:id/ai', edit, handle(async req => {
  await AI.start(req, req.params.id, Array.isArray(req.body?.documentIds) ? req.body.documentIds : undefined);
  return D.card(req.params.id);
}));
declarationRoutes.post('/declarations/:id/reviews/:review/clear', edit, handle(async req => { await AI.clearReview(req, req.params.id, req.params.review, req.body?.note); return D.card(req.params.id); }));
declarationRoutes.post('/declarations/:id/reviews/:review/reopen', edit, handle(async req => { await AI.clearReview(req, req.params.id, req.params.review, null, true); return D.card(req.params.id); }));
declarationRoutes.post('/declarations/:id/reviews/:review/create-partner', need('partner.edit'), edit, handle(async req => {
  await AI.createPartnerFromReview(req, req.params.id, req.params.review);
  return D.card(req.params.id);
}));

declarationRoutes.post('/declarations/:id/items', edit, handle(req => D.addItem(req, req.params.id, req.body ?? {})));
declarationRoutes.post('/declarations/:id/items/bulk', edit, handle(req => D.bulkItems(req, req.params.id, req.body ?? {})));
declarationRoutes.put('/declarations/:id/items/:item', edit, handle(req => D.updateItem(req, req.params.id, req.params.item, req.body ?? {})));
declarationRoutes.post('/declarations/:id/items/:item/remove', edit, handle(req => D.removeItem(req, req.params.id, req.params.item, req.body?.version)));
declarationRoutes.post('/declarations/:id/items/:item/move', edit, handle(req =>
  D.moveItem(req, req.params.id, req.params.item, z.object({ to: z.coerce.number().int() }).parse(req.body ?? {}).to, req.body?.version)));
