import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/** An error with an HTTP status and a message meant for the user (Norwegian; the client translates). */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export const fail = (status: number, message: string, code?: string): never => { throw new HttpError(status, message, code); };

/** Wrap an async route: its result is sent as JSON, a thrown error becomes a clean answer. */
export const handle = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) { next(e); }
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof ZodError) return res.status(400).json({ error: 'Ugyldige data', code: 'INVALID', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
  console.error(err);
  res.status(500).json({ error: 'Intern feil', code: 'INTERNAL' });
}
