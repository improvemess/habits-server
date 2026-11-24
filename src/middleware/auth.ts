import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { forbidden, unauthorized } from '../errors.js';
import { type Auth, type DeviceAuth, type ReaderAuth } from '../services/auth.js';
import { type OwnerService } from '../services/owner-service.js';

const AUTH_KEY = 'auth';

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * Authenticates the bearer token and allows only the given token kinds.
 * A reader token on a write endpoint is rejected with 403.
 */
export function authenticate(owners: OwnerService, ...allowed: Auth['kind'][]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    const auth = token === undefined ? undefined : owners.authenticate(token);
    if (auth === undefined) {
      next(unauthorized());
      return;
    }
    if (!allowed.includes(auth.kind)) {
      next(
        forbidden(
          auth.kind === 'reader'
            ? 'Reader tokens are read-only'
            : 'This endpoint needs a reader token',
        ),
      );
      return;
    }
    res.locals[AUTH_KEY] = auth;
    next();
  };
}

export function getAuth(res: Response): Auth {
  return res.locals[AUTH_KEY] as Auth;
}

export function getDeviceAuth(res: Response): DeviceAuth {
  return res.locals[AUTH_KEY] as DeviceAuth;
}

export function getReaderAuth(res: Response): ReaderAuth {
  return res.locals[AUTH_KEY] as ReaderAuth;
}
