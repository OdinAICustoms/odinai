import { Router } from 'express';
import { handle, fail } from '../errors.js';
import { need } from '../auth/guard.js';
import * as S from './service.js';

/** Digitoll (phase 3b). Reading needs declaration.read; creating, changing and sending need declaration.edit. */
export const digitollRoutes = Router();
const read = need('declaration.read'), edit = need('declaration.edit');
const kindOf = (s: string) => S.KINDS[s] ?? fail(404, 'Ukjent Digitoll-type.');

digitollRoutes.get('/digitoll', read, handle(() => S.overview()));
digitollRoutes.post('/digitoll/houses/from-declaration/:declId', edit, handle(req => S.fromDeclaration(req, req.params.declId)));
digitollRoutes.post('/digitoll/transports/:id/arrival', edit, handle(req => S.registerArrival(req, req.params.id)));
digitollRoutes.post('/digitoll/:kind', edit, handle(req => S.create(req, kindOf(req.params.kind), req.body ?? {})));
digitollRoutes.get('/digitoll/:kind/:id', read, handle(req => S.card(kindOf(req.params.kind), req.params.id)));
digitollRoutes.put('/digitoll/:kind/:id', edit, handle(req => S.update(req, kindOf(req.params.kind), req.params.id, req.body ?? {})));
digitollRoutes.post('/digitoll/:kind/:id/send', edit, handle(req => S.send(req, kindOf(req.params.kind), req.params.id)));
digitollRoutes.post('/digitoll/:kind/:id/cancel', edit, handle(req => S.cancel(req, kindOf(req.params.kind), req.params.id, req.body?.reason)));
