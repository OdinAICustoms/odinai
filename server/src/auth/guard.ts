import type { NextFunction, Request, Response } from 'express';
import { fail, HttpError } from '../errors.js';
import { resolve } from './sessions.js';
import type { Permission } from './roles.js';

const PUBLIC = [/^\/health$/, /^\/auth\/(config|setup|login|logout)$/];
const DURING_PASSWORD_CHANGE = [/^\/auth\/(me|password|logout)$/, /^\/me\/lang$/];

/**
 * Every /api request: session first (except the public routes), then a password change if one is
 * due. Writes must carry the header X-OdinAi: 1 — a page on another site cannot set it, so a
 * cookie alone can never make a change (CSRF).
 */
export async function guard(req: Request, res: Response, next: NextFunction) {
  try {
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (write && req.get('X-OdinAi') !== '1') fail(403, 'Forespørselen mangler OdinAi-hodet.', 'CSRF');
    if (PUBLIC.some(re => re.test(req.path))) return next();
    const user = await resolve(req);
    if (!user) fail(401, 'Ikke innlogget', 'AUTH');
    req.user = user!;
    if (user!.mustChange && !DURING_PASSWORD_CHANGE.some(re => re.test(req.path))) fail(403, 'Du må velge et nytt passord før du fortsetter.', 'PW_CHANGE');
    next();
  } catch (e) { next(e); }
}

/** Route-level permission check. */
export const need = (perm: Permission) => (req: Request, _res: Response, next: NextFunction) =>
  req.user?.perms.includes(perm) ? next() : next(new HttpError(403, `Du har ikke tilgang til dette (mangler rettigheten «${perm}»).`, 'NO_PERM'));
