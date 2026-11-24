import { type NextFunction, type Request, type Response } from 'express';

interface StatusError {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
}

/** Turns every error into `{ "error": "…" }`; hides details of server errors. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const candidate = (typeof err === 'object' && err !== null ? err : {}) as StatusError;
  const raw = candidate.status ?? candidate.statusCode;
  const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
  if (status >= 500) {
    console.error(err);
    res.status(status).json({ error: 'Internal server error' });
    return;
  }
  const message = err instanceof Error ? err.message : 'Request failed';
  res.status(status).json({ error: message });
}
