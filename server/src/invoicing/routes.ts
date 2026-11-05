import { Router } from 'express';
import { handle } from '../errors.js';
import { need } from '../auth/guard.js';
import * as S from './service.js';
import * as F from './fiken.js';

/**
 * Invoicing (phase 4a). Reading needs invoice.read; drafts need invoice.edit; issuing, crediting and the
 * company settings need invoice.issue.
 */
export const invoicingRoutes = Router();
const read = need('invoice.read'), edit = need('invoice.edit'), issue = need('invoice.issue');
const q = (req: any) => Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));

invoicingRoutes.get('/invoicing/meta', read, handle(() => S.meta()));
invoicingRoutes.get('/invoicing/summary', read, handle(() => S.summary()));
invoicingRoutes.get('/invoicing/settings', read, handle(() => S.settings()));
invoicingRoutes.put('/invoicing/settings', issue, handle(req => S.saveSettings(req, req.body ?? {})));
invoicingRoutes.put('/invoicing/price-items/:code', issue, handle(req => S.savePriceItem(req, req.params.code, req.body ?? {})));
invoicingRoutes.get('/invoicing/basis', read, handle(req => S.basis(q(req))));
invoicingRoutes.post('/invoicing/run', edit, handle(req => S.run(req, req.body ?? {})));

invoicingRoutes.get('/invoices', read, handle(req => S.list(q(req))));
invoicingRoutes.post('/invoices', edit, handle(req => S.createDraft(req, req.body ?? {})));
invoicingRoutes.get('/invoices/:id', read, handle(req => S.card(req.params.id)));
invoicingRoutes.put('/invoices/:id', edit, handle(req => S.updateHeader(req, req.params.id, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/lines', edit, handle(req => S.addLine(req, req.params.id, req.body ?? {})));
invoicingRoutes.put('/invoices/:id/lines/:lineId', edit, handle(req => S.updateLine(req, req.params.id, req.params.lineId, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/lines/:lineId/remove', edit, handle(req => S.removeLine(req, req.params.id, req.params.lineId, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/declarations/:declId/remove', edit, handle(req => S.removeDeclaration(req, req.params.id, req.params.declId, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/discard', edit, handle(req => S.discard(req, req.params.id, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/issue', issue, handle(req => S.issue(req, req.params.id, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/credit', issue, handle(req => S.credit(req, req.params.id, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/payments', edit, handle(req => S.registerPayment(req, req.params.id, req.body ?? {})));
invoicingRoutes.post('/invoices/:id/payments/:paymentId/reverse', edit, handle(req => S.reversePayment(req, req.params.id, req.params.paymentId, req.body ?? {})));
invoicingRoutes.get('/invoicing/fiken', read, handle(() => F.overview()));
invoicingRoutes.post('/invoicing/fiken/catch-up', issue, handle(req => F.catchUp(req)));
invoicingRoutes.post('/invoicing/fiken/:jobId/retry', issue, handle(req => F.retry(req, req.params.jobId)));
invoicingRoutes.post('/invoicing/fiken/:jobId/cancel', issue, handle(req => F.cancel(req, req.params.jobId, req.body?.reason)));
invoicingRoutes.get('/invoices/:id/ehf', read, async (req, res, next) => {
  try {
    const e = await S.ehf(req.params.id);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(e.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(e.xml);
  } catch (err) { next(err); }
});
invoicingRoutes.get('/invoices/:id/pdf', read, async (req, res, next) => {
  try {
    const p = await S.pdf(req, req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(p.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(p.buffer);
  } catch (e) { next(e); }
});
