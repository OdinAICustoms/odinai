import { Router } from 'express';
import { z } from 'zod';
import { handle, fail } from '../errors.js';
import { audit } from '../audit.js';
import { need } from '../auth/guard.js';
import { DATASETS } from './datasets.js';
import { runAll, runById, status } from './runner.js';
import * as L from './lookup.js';

export const refdataRoutes = Router();

refdataRoutes.get('/refdata/status', handle(() => status()));

/** Start a refresh (one dataset or all) in the background; the status page shows progress. */
refdataRoutes.post('/refdata/refresh', need('settings.edit'), handle(async req => {
  const { dataset } = z.object({ dataset: z.string().optional() }).parse(req.body ?? {});
  if (dataset && !DATASETS.some(d => d.id === dataset)) fail(400, 'Ukjent datasett.');
  await audit(req, { action: 'REFDATA_REFRESH', objectType: 'REFDATA', objectId: dataset ?? 'ALL' });
  const opts = { userId: req.user!.id };
  void (dataset ? runById(dataset, opts) : runAll(opts)).catch(e => console.error('refresh:', e));
  return { started: dataset ?? 'ALL' };
}));

const dateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
refdataRoutes.get('/refdata/tariff', handle(req => L.searchTariff(z.string().parse(req.query.q ?? ''))));
refdataRoutes.get('/refdata/tariff/:code', handle(async req => {
  const t = await L.tariffCode(req.params.code, dateQ.parse(req.query.date));
  return t ?? fail(404, 'Varenummeret finnes ikke i tolltariffen.');
}));
refdataRoutes.get('/refdata/countries', handle(() => L.countries()));
refdataRoutes.get('/refdata/countries/:code/groups', handle(async req => ({ groups: await L.groupsOf(req.params.code, dateQ.parse(req.query.date)) })));
refdataRoutes.get('/refdata/currencies', handle(() => L.currencies()));
refdataRoutes.get('/refdata/fx/:currency', handle(async req => (await L.fxRate(req.params.currency, dateQ.parse(req.query.date))) ?? fail(404, 'Ingen tollkurs for valutaen på datoen.')));
refdataRoutes.get('/refdata/errors/:number', handle(async req => (await L.errorText(req.params.number)) ?? fail(404, 'Ukjent feilkode.')));
refdataRoutes.get('/refdata/postnummer', handle(req => L.postalSearch(String(req.query.q ?? ''))));
const dirQ = z.enum(['IMPORT', 'EXPORT']).optional();
refdataRoutes.get('/refdata/offices', handle(req => L.offices(dirQ.parse(req.query.direction), dateQ.parse(req.query.date))));
refdataRoutes.get('/refdata/procedures', handle(req => L.procedures(dateQ.parse(req.query.date))));
refdataRoutes.get('/refdata/import-refs', handle(req => L.importRefs(dateQ.parse(req.query.date))));
