import { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

function limiter(limit: number, skipSuccessfulRequests: boolean): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    skipSuccessfulRequests,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Too many requests, try again later' });
    },
  });
}

/** General limit for the whole API. */
export const apiRateLimit = (limit: number): RequestHandler => limiter(limit, false);

/**
 * Strict limit for endpoints that check secrets (owner secret, invite code).
 * Only failed attempts count, so legitimate retries are never blocked.
 */
export const secretRateLimit = (limit: number): RequestHandler => limiter(limit, true);
