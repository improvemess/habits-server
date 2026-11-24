import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const days = (fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  BASE_PATH: z
    .string()
    .default('')
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => value === '' || /^\/[A-Za-z0-9._~\-/]*$/.test(value), {
      message: 'BASE_PATH must be empty or start with "/"',
    }),
  PUBLIC_URL: z
    .string()
    .default('')
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => value === '' || URL.canParse(value), {
      message: 'PUBLIC_URL must be an absolute URL',
    }),
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((value): boolean | number | string => {
      if (value === 'true') return true;
      if (value === 'false' || value === '') return false;
      return /^\d+$/.test(value) ? Number(value) : value;
    }),
  DATABASE_PATH: z.string().min(1).default('./data/uhabits.db'),
  APP_DOWNLOAD_URL: z.url().default('https://github.com/oliverlorenz/uhabits/releases'),
  INVITE_TTL_DAYS: days(7),
  TOMBSTONE_RETENTION_DAYS: days(30),
  SHARE_INACTIVE_AFTER_DAYS: days(90),
  SHARE_DELETE_AFTER_DAYS: days(365),
  READER_RETENTION_DAYS: days(180),
  DEVICE_RETENTION_DAYS: days(365),
  CLEANUP_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  RATE_LIMIT_API: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_SECRETS: z.coerce.number().int().positive().default(20),
});

/** Retention periods in milliseconds. */
export interface Retention {
  inviteTtl: number;
  tombstone: number;
  shareInactiveAfter: number;
  shareDeleteAfter: number;
  reader: number;
  device: number;
}

export interface Config {
  port: number;
  /** Path prefix the whole server is mounted under, without trailing slash ('' = root). */
  basePath: string;
  /** Public URL including basePath, without trailing slash; '' = derive from the request. */
  publicUrl: string;
  trustProxy: boolean | number | string;
  databasePath: string;
  /** Where the invite landing page tells friends to get the app. */
  appDownloadUrl: string;
  retention: Retention;
  cleanupInterval: number;
  rateLimit: { api: number; secrets: number };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    port: e.PORT,
    basePath: e.BASE_PATH,
    publicUrl: e.PUBLIC_URL,
    trustProxy: e.TRUST_PROXY,
    databasePath: e.DATABASE_PATH,
    appDownloadUrl: e.APP_DOWNLOAD_URL,
    retention: {
      inviteTtl: e.INVITE_TTL_DAYS * DAY_MS,
      tombstone: e.TOMBSTONE_RETENTION_DAYS * DAY_MS,
      shareInactiveAfter: e.SHARE_INACTIVE_AFTER_DAYS * DAY_MS,
      shareDeleteAfter: e.SHARE_DELETE_AFTER_DAYS * DAY_MS,
      reader: e.READER_RETENTION_DAYS * DAY_MS,
      device: e.DEVICE_RETENTION_DAYS * DAY_MS,
    },
    cleanupInterval: e.CLEANUP_INTERVAL_HOURS * HOUR_MS,
    rateLimit: { api: e.RATE_LIMIT_API, secrets: e.RATE_LIMIT_SECRETS },
  };
}
