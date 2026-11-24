import { Router, type Request, type Response } from 'express';
import { iso } from '../clock.js';
import { authenticate, getAuth, getDeviceAuth } from '../middleware/auth.js';
import { mergePaths, operation } from '../openapi/operation.js';
import {
  ENTRIES_PER_BATCH,
  createdShareSchema,
  inviteSchema,
  metaSchema,
  putEntriesResultSchema,
  putEntriesSchema,
  readersSchema,
  shareQuerySchema,
  shareSchema,
} from '../schemas.js';
import { type OwnerService } from '../services/owner-service.js';
import { type ShareService, type ShareView } from '../services/share-service.js';
import { parse } from '../validation.js';

const shareIdParam = { shareId: 'Id of the share' };
const TAG = 'Shares';

const writeErrors = {
  400: 'Invalid request body',
  401: 'Missing or invalid token',
  403: 'Reader tokens are read-only',
  404: 'Share not found (or owned by someone else)',
  410: 'Share has ended',
} as const;

export const openApiPaths = mergePaths(
  operation({
    method: 'post',
    path: '/api/v1/shares',
    tag: TAG,
    summary: 'Create a share',
    description: [
      'Shares one habit. `meta` holds its encrypted master data; the share key stays in the',
      'app and only travels in the fragment of invite links.',
    ].join(' '),
    auth: 'device',
    body: metaSchema,
    responses: { 201: { description: 'Share created', schema: createdShareSchema } },
    errors: { 400: 'Invalid request body', 401: 'Missing or invalid token', 403: writeErrors[403] },
  }),
  operation({
    method: 'get',
    path: '/api/v1/shares/{shareId}',
    tag: TAG,
    summary: 'Read a share',
    description: [
      'Returns the master data and the entries changed after `since`. Every change (meta,',
      'entries, end) increments the share `revision`; a client stores the `revision` of a',
      'response and passes it as `since` next time to get only what changed. Entries are',
      'returned in their latest state per day. Once ended, `status` is `ended`, `meta` is',
      '`null` and `entries` is empty; after the tombstone is cleaned up (30 days) the share',
      'answers 404 and reader tokens stop working.',
    ].join(' '),
    auth: 'deviceOrReader',
    pathParams: shareIdParam,
    query: shareQuerySchema,
    responses: { 200: { description: 'Share', schema: shareSchema } },
    errors: {
      400: 'Invalid `since`',
      401: 'Missing or invalid token',
      404: 'Share not found or not accessible with this token',
    },
  }),
  operation({
    method: 'delete',
    path: '/api/v1/shares/{shareId}',
    tag: TAG,
    summary: 'End a share',
    description: [
      'Ends the share, e.g. because the owner stopped sharing or deleted the habit. Meta,',
      'entries and open invites are deleted at once; a tombstone (id, end date) stays for 30',
      'days so friends see that the share ended.',
    ].join(' '),
    auth: 'device',
    pathParams: shareIdParam,
    responses: { 204: { description: 'Share ended' } },
    errors: {
      401: writeErrors[401],
      403: writeErrors[403],
      404: writeErrors[404],
      410: 'Share has already ended',
    },
  }),
  operation({
    method: 'put',
    path: '/api/v1/shares/{shareId}/meta',
    tag: TAG,
    summary: 'Update master data',
    description: 'Replaces the encrypted master data, e.g. after the habit was renamed.',
    auth: 'device',
    pathParams: shareIdParam,
    body: metaSchema,
    responses: { 200: { description: 'Updated', schema: createdShareSchema } },
    errors: writeErrors,
  }),
  operation({
    method: 'put',
    path: '/api/v1/shares/{shareId}/entries',
    tag: TAG,
    summary: 'Upload entries',
    description: [
      `Uploads up to ${ENTRIES_PER_BATCH} entries per request (send larger histories in batches).`,
      '`date` and `updatedAt` are plain text, `data` is ciphertext. Per `(share, date)` the',
      '**last writer wins** by `updatedAt`: an entry replaces the stored one only if it is',
      'newer; on equal timestamps the higher `deviceId` wins, so all servers and devices agree.',
      'Older entries are ignored, not rejected, which makes retries safe. `updatedAt` values',
      'in the future are clamped to the server time.',
    ].join(' '),
    auth: 'device',
    pathParams: shareIdParam,
    body: putEntriesSchema,
    responses: { 200: { description: 'Entries processed', schema: putEntriesResultSchema } },
    errors: writeErrors,
  }),
  operation({
    method: 'post',
    path: '/api/v1/shares/{shareId}/invites',
    tag: TAG,
    summary: 'Create an invite',
    description: [
      'Creates an invite that can be redeemed **once** and expires after 7 days. The app turns',
      'the returned `url` into the invite link by appending the share key as fragment:',
      '`https://<server-base>/invite/<code>#k=<share-key>&v=1`. The fragment is never sent to',
      'the server. The server base may include a path, so the app derives it by cutting off',
      '`/invite/<code>`.',
    ].join(' '),
    auth: 'device',
    pathParams: shareIdParam,
    responses: { 201: { description: 'Invite created', schema: inviteSchema } },
    errors: {
      401: writeErrors[401],
      403: writeErrors[403],
      404: writeErrors[404],
      410: writeErrors[410],
    },
  }),
  operation({
    method: 'get',
    path: '/api/v1/shares/{shareId}/readers',
    tag: TAG,
    summary: 'List readers',
    description: 'Friends who redeemed an invite for this share, with their display names.',
    auth: 'device',
    pathParams: shareIdParam,
    responses: { 200: { description: 'Readers', schema: readersSchema } },
    errors: {
      401: writeErrors[401],
      403: writeErrors[403],
      404: writeErrors[404],
      410: writeErrors[410],
    },
  }),
  operation({
    method: 'delete',
    path: '/api/v1/shares/{shareId}/readers/{readerId}',
    tag: TAG,
    summary: 'Remove a reader',
    description: 'Removes a friend from the share; their reader token stops working.',
    auth: 'device',
    pathParams: { ...shareIdParam, readerId: 'Reader to remove' },
    responses: { 204: { description: 'Reader removed' } },
    errors: {
      401: writeErrors[401],
      403: writeErrors[403],
      404: 'Share or reader not found',
      410: writeErrors[410],
    },
  }),
);

function shareJson(share: ShareView): Record<string, unknown> {
  return {
    shareId: share.id,
    ownerId: share.ownerId,
    status: share.status,
    meta: share.meta,
    entries: share.entries.map((entry) => ({ ...entry, updatedAt: iso(entry.updatedAt) })),
    revision: share.revision,
    createdAt: iso(share.createdAt),
    updatedAt: iso(share.updatedAt),
    endedAt: share.endedAt === null ? null : iso(share.endedAt),
  };
}

/** Builds the public URL of the invite landing page, without the key fragment. */
export type InviteUrl = (req: Request, code: string) => string;

export function createSharesRouter(
  owners: OwnerService,
  shares: ShareService,
  inviteUrl: InviteUrl,
): Router {
  const router = Router();
  const deviceAuth = authenticate(owners, 'device');
  const anyAuth = authenticate(owners, 'device', 'reader');
  const shareId = (req: Request): string => String(req.params['shareId']);

  router.post('/shares', deviceAuth, (req: Request, res: Response) => {
    const body = parse(metaSchema, req.body);
    const share = shares.create(getDeviceAuth(res), body.meta);
    res.status(201).json({ shareId: share.id, status: share.status, revision: share.revision });
  });

  router.get('/shares/:shareId', anyAuth, (req: Request, res: Response) => {
    const query = parse(shareQuerySchema, req.query);
    res.json(shareJson(shares.get(getAuth(res), shareId(req), query.since)));
  });

  router.delete('/shares/:shareId', deviceAuth, (req: Request, res: Response) => {
    shares.end(getDeviceAuth(res), shareId(req));
    res.status(204).end();
  });

  router.put('/shares/:shareId/meta', deviceAuth, (req: Request, res: Response) => {
    const body = parse(metaSchema, req.body);
    const revision = shares.updateMeta(getDeviceAuth(res), shareId(req), body.meta);
    res.json({ shareId: shareId(req), status: 'active', revision });
  });

  router.put('/shares/:shareId/entries', deviceAuth, (req: Request, res: Response) => {
    const body = parse(putEntriesSchema, req.body);
    res.json(shares.putEntries(getDeviceAuth(res), shareId(req), body.entries));
  });

  router.post('/shares/:shareId/invites', deviceAuth, (req: Request, res: Response) => {
    const invite = shares.createInvite(getDeviceAuth(res), shareId(req));
    res.status(201).json({
      code: invite.code,
      url: inviteUrl(req, invite.code),
      expiresAt: iso(invite.expiresAt),
    });
  });

  router.get('/shares/:shareId/readers', deviceAuth, (req: Request, res: Response) => {
    const readers = shares.listReaders(getDeviceAuth(res), shareId(req));
    res.json({
      readers: readers.map((reader) => ({
        readerId: reader.readerId,
        displayName: reader.displayName,
        createdAt: iso(reader.createdAt),
        lastSeenAt: iso(reader.lastSeenAt),
      })),
    });
  });

  router.delete('/shares/:shareId/readers/:readerId', deviceAuth, (req: Request, res: Response) => {
    shares.removeReader(getDeviceAuth(res), shareId(req), String(req.params['readerId']));
    res.status(204).end();
  });

  return router;
}
