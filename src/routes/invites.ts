import { Router, type Request, type RequestHandler, type Response } from 'express';
import { authenticate, getReaderAuth } from '../middleware/auth.js';
import { mergePaths, operation } from '../openapi/operation.js';
import { redeemSchema, redeemedSchema } from '../schemas.js';
import { type OwnerService } from '../services/owner-service.js';
import { type ShareService } from '../services/share-service.js';
import { parse } from '../validation.js';

export const openApiPaths = mergePaths(
  operation({
    method: 'post',
    path: '/api/v1/invites/{code}/redeem',
    tag: 'Invites & subscriptions',
    summary: 'Redeem an invite',
    description: [
      'Exchanges an invite code for a read-only **reader token** for its share. Every invite',
      'can be redeemed once. The reader token can only read this one share; every write with',
      'it is rejected with 403. Failed attempts are rate limited.',
    ].join(' '),
    auth: 'none',
    pathParams: { code: 'Invite code from the invite link' },
    body: redeemSchema,
    responses: { 201: { description: 'Invite redeemed', schema: redeemedSchema } },
    errors: {
      400: 'Invalid request body',
      404: 'Invite not found',
      410: 'Invite expired or already redeemed, or the share has ended',
    },
  }),
  operation({
    method: 'delete',
    path: '/api/v1/subscriptions/self',
    tag: 'Invites & subscriptions',
    summary: 'Cancel own subscription',
    description: 'The friend stops following the share. The reader token stops working.',
    auth: 'reader',
    responses: { 204: { description: 'Subscription cancelled' } },
    errors: {
      401: 'Missing or invalid token',
      403: 'This endpoint needs a reader token',
    },
  }),
);

export function createInvitesRouter(
  owners: OwnerService,
  shares: ShareService,
  secretLimit: RequestHandler,
): Router {
  const router = Router();

  router.post('/invites/:code/redeem', secretLimit, (req: Request, res: Response) => {
    const body = parse(redeemSchema, req.body ?? {});
    const redemption = shares.redeem(String(req.params['code']), body.displayName);
    res.status(201).json(redemption);
  });

  router.delete(
    '/subscriptions/self',
    authenticate(owners, 'reader'),
    (_req: Request, res: Response) => {
      shares.unsubscribe(getReaderAuth(res));
      res.status(204).end();
    },
  );

  return router;
}
