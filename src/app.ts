import express, { Router, type Request, type Response } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { type Clock, systemClock } from './clock.js';
import { type Config, type Retention } from './config.js';
import { type Database } from './db/database.js';
import { notFound } from './errors.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiRateLimit, secretRateLimit } from './middleware/rate-limit.js';
import { buildOpenApiSpec } from './openapi.js';
import { createInvitePageRouter } from './routes/invite-page.js';
import { createInvitesRouter } from './routes/invites.js';
import { createOwnersRouter } from './routes/owners.js';
import { createSharesRouter, type InviteUrl } from './routes/shares.js';
import { createSystemRouter } from './routes/system.js';
import { OwnerService } from './services/owner-service.js';
import { ShareService } from './services/share-service.js';

export interface Services {
  owners: OwnerService;
  shares: ShareService;
}

export function createServices(
  db: Database,
  retention: Retention,
  clock: Clock = systemClock,
): Services {
  return {
    owners: new OwnerService(db, clock),
    shares: new ShareService(db, clock, retention),
  };
}

/** Request line for the access log, with invite codes redacted. */
morgan.token('safe-url', (req: Request) =>
  req.originalUrl.replace(/\/(invites?)\/[^/?#]+/g, '/$1/:code'),
);
const LOG_FORMAT =
  ':remote-addr - [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":user-agent"';

/** All routers with the prefix they are mounted under, relative to the base path. */
export function createRouters(
  config: Config,
  services: Services,
): { prefix: string; router: Router }[] {
  const secretLimit = secretRateLimit(config.rateLimit.secrets);
  const spec = buildOpenApiSpec(config.basePath);
  const inviteUrl: InviteUrl = (req, code) => {
    const base =
      config.publicUrl !== ''
        ? config.publicUrl
        : `${req.protocol}://${req.get('host') ?? 'localhost'}${config.basePath}`;
    return `${base}/invite/${code}`;
  };
  return [
    { prefix: '', router: createSystemRouter(spec, config.basePath) },
    { prefix: '', router: createInvitePageRouter(services.shares, config.appDownloadUrl) },
    { prefix: '/api/v1', router: createOwnersRouter(services.owners, secretLimit) },
    {
      prefix: '/api/v1',
      router: createSharesRouter(services.owners, services.shares, inviteUrl),
    },
    {
      prefix: '/api/v1',
      router: createInvitesRouter(services.owners, services.shares, secretLimit),
    },
  ];
}

export function createApp(config: Config, services: Services): express.Application {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(helmet());
  if (process.env['NODE_ENV'] !== 'test') app.use(morgan(LOG_FORMAT));

  const root = Router();
  root.use('/docs', swaggerUi.serve, swaggerUi.setup(buildOpenApiSpec(config.basePath)));

  root.use('/api', apiRateLimit(config.rateLimit.api), express.json({ limit: '2mb' }));
  for (const { prefix, router } of createRouters(config, services)) {
    if (prefix === '') root.use(router);
    else root.use(prefix, router);
  }
  root.use((_req: Request, _res: Response, next: express.NextFunction) => {
    next(notFound('Route not found'));
  });

  app.use(config.basePath === '' ? '/' : config.basePath, root);
  app.use((_req: Request, _res: Response, next: express.NextFunction) => {
    next(notFound('Route not found'));
  });
  app.use(errorHandler);
  return app;
}
