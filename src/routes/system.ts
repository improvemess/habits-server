import { Router, type Request, type Response } from 'express';
import type { OpenAPIV3_1 } from 'openapi-types';
import { mergePaths, operation } from '../openapi/operation.js';
import { z } from 'zod';
import { discoverySchema, healthSchema, versionSchema } from '../schemas.js';

const API_VERSIONS = ['v1'];

export const appVersion = (): string => process.env['APP_VERSION'] ?? 'dev';

export const openApiPaths = mergePaths(
  operation({
    method: 'get',
    path: '/health',
    tag: 'System',
    summary: 'Health check',
    description: 'Used by the Docker `HEALTHCHECK`. Needs no token.',
    auth: 'none',
    responses: { 200: { description: 'Server is up', schema: healthSchema } },
  }),
  operation({
    method: 'get',
    path: '/version',
    tag: 'System',
    summary: 'Server version',
    description: 'Version of the running server (`APP_VERSION` from the Docker build).',
    auth: 'none',
    responses: { 200: { description: 'Version', schema: versionSchema } },
  }),
  operation({
    method: 'get',
    path: '/.well-known/uhabits-server',
    tag: 'System',
    summary: 'Server discovery',
    description: [
      'The app calls this before it uses a server, e.g. after the user entered a server URL or',
      'opened an invite link. It lives below the configured base path, so a server mounted at',
      '`https://example.com/habits` answers at `https://example.com/habits/.well-known/uhabits-server`.',
    ].join(' '),
    auth: 'none',
    responses: { 200: { description: 'This is a uhabits server', schema: discoverySchema } },
  }),
  operation({
    method: 'get',
    path: '/openapi.json',
    tag: 'System',
    summary: 'OpenAPI specification',
    description:
      'This specification as JSON (OpenAPI 3.1), e.g. for generating clients. The interactive version is at `/docs`.',
    auth: 'none',
    responses: {
      200: {
        description: 'OpenAPI document',
        schema: z.looseObject({ openapi: z.string() }).meta({ examples: [{ openapi: '3.1.0' }] }),
      },
    },
  }),
);

export function createSystemRouter(spec: OpenAPIV3_1.Document, basePath: string): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.redirect(302, `${basePath}/docs`);
  });

  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(spec);
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  router.get('/version', (_req: Request, res: Response) => {
    res.json({ version: appVersion() });
  });

  router.get('/.well-known/uhabits-server', (_req: Request, res: Response) => {
    res.json({ apiVersions: API_VERSIONS, version: appVersion() });
  });

  return router;
}
