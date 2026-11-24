import { z } from 'zod';

/**
 * Request and response schemas. They are the single source of truth: routes
 * validate with them and the OpenAPI spec is generated from them.
 */

const EXAMPLE_OWNER_ID = '5b0c3c1e-8a5f-4d7e-9a3b-2f1c6d7e8f90';
const EXAMPLE_DEVICE_ID = 'c2a7e5d4-1b3f-4e6a-8d9c-0f1e2d3c4b5a';
const EXAMPLE_SHARE_ID = '9f8e7d6c-5b4a-4f3e-a2d1-c0b9a8f7e6d5';
const EXAMPLE_READER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const EXAMPLE_CIPHERTEXT = 'AQx1b3A2c2VjcmV0Lg…';

const uuidV4 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    message: 'must be a lowercase UUID v4',
  });

const ownerSecret = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: 'must be 32 bytes as lowercase hex' })
  .meta({ description: '256-bit secret as 64 lowercase hex characters. Never logged.' });

const timestamp = z.iso.datetime({ offset: true });

/**
 * Opaque ciphertext produced by the app (AES-256-GCM, versioned wire format,
 * see oliverlorenz/uhabits#30), encoded as base64url without padding. The
 * server never decrypts it and never sees the key.
 */
const ciphertext = (maxLength: number): z.ZodString =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^[A-Za-z0-9_-]+$/, { message: 'must be base64url without padding' });

const META_MAX = 16 * 1024;
const ENTRY_MAX = 1024;
export const ENTRIES_PER_BATCH = 500;

export const errorSchema = z
  .object({ error: z.string() })
  .meta({ examples: [{ error: 'Share not found' }] });

// --- system ---

export const healthSchema = z
  .object({ status: z.literal('ok'), uptime: z.number() })
  .meta({ examples: [{ status: 'ok', uptime: 42.1 }] });

export const versionSchema = z
  .object({ version: z.string() })
  .meta({ examples: [{ version: '1.0.0' }] });

export const discoverySchema = z
  .object({
    apiVersions: z.array(z.string()).meta({ description: 'Supported API versions' }),
    version: z.string().meta({ description: 'Server version' }),
  })
  .meta({ examples: [{ apiVersions: ['v1'], version: '1.0.0' }] });

// --- owners & devices ---

export const createOwnerSchema = z
  .object({ ownerId: uuidV4, ownerSecret })
  .meta({ examples: [{ ownerId: EXAMPLE_OWNER_ID, ownerSecret: 'a1'.repeat(32) }] });

export const ownerSchema = z
  .object({ ownerId: uuidV4, createdAt: timestamp })
  .meta({ examples: [{ ownerId: EXAMPLE_OWNER_ID, createdAt: '2026-11-24T10:00:00.000Z' }] });

export const registerDeviceSchema = z
  .object({
    ownerSecret,
    deviceId: uuidV4.meta({ description: 'Per-installation id of the device' }),
    name: z.string().trim().min(1).max(100).optional().meta({
      description: 'Optional human-readable name, e.g. "Pixel 8"',
    }),
  })
  .meta({
    examples: [{ ownerSecret: 'a1'.repeat(32), deviceId: EXAMPLE_DEVICE_ID, name: 'Pixel 8' }],
  });

export const deviceTokenSchema = z
  .object({
    ownerId: uuidV4,
    deviceId: uuidV4,
    deviceToken: z.string().meta({
      description: 'Bearer token for this device. Shown only once; the server stores a hash.',
    }),
  })
  .meta({
    examples: [
      {
        ownerId: EXAMPLE_OWNER_ID,
        deviceId: EXAMPLE_DEVICE_ID,
        deviceToken: 'dt_q5h0lW4mZy0bJ2…',
      },
    ],
  });

export const heartbeatSchema = z
  .object({ deviceId: uuidV4, lastSeenAt: timestamp })
  .meta({ examples: [{ deviceId: EXAMPLE_DEVICE_ID, lastSeenAt: '2026-11-24T10:00:00.000Z' }] });

// --- shares ---

const shareStatusSchema = z.enum(['active', 'inactive', 'ended']).meta({
  description:
    '`active`: the owner was seen recently. `inactive`: no owner device has sent a heartbeat for a while (default 90 days). `ended`: the owner ended the share; its content is gone.',
});

export const metaSchema = z
  .object({
    meta: ciphertext(META_MAX).meta({
      description:
        'Encrypted master data of the habit (name, colour, frequency, …), base64url. The server stores it as is.',
    }),
  })
  .meta({ examples: [{ meta: EXAMPLE_CIPHERTEXT }] });

export const createdShareSchema = z
  .object({ shareId: uuidV4, status: shareStatusSchema, revision: z.number().int() })
  .meta({ examples: [{ shareId: EXAMPLE_SHARE_ID, status: 'active', revision: 1 }] });

const entryInputSchema = z.object({
  date: z.iso.date().meta({ description: 'Day of the entry (YYYY-MM-DD), plain text' }),
  data: ciphertext(ENTRY_MAX).meta({ description: 'Encrypted entry (state/value), base64url' }),
  updatedAt: timestamp.meta({
    description: 'When the entry was last changed on the device; decides last writer wins',
  }),
  deviceId: uuidV4.meta({ description: 'Device that made the change' }),
});

export const putEntriesSchema = z
  .object({ entries: z.array(entryInputSchema).min(1).max(ENTRIES_PER_BATCH) })
  .meta({
    examples: [
      {
        entries: [
          {
            date: '2026-11-24',
            data: EXAMPLE_CIPHERTEXT,
            updatedAt: '2026-11-24T19:30:00.000Z',
            deviceId: EXAMPLE_DEVICE_ID,
          },
        ],
      },
    ],
  });

export const putEntriesResultSchema = z
  .object({
    accepted: z.number().int().meta({ description: 'Entries stored' }),
    ignored: z
      .number()
      .int()
      .meta({ description: 'Entries dropped because the server already had a newer one' }),
    revision: z.number().int(),
  })
  .meta({ examples: [{ accepted: 1, ignored: 0, revision: 7 }] });

export const shareQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0).meta({
    description:
      'Return only entries changed after this revision. Pass the `revision` of the previous response; omit (or 0) for everything.',
  }),
});

const entrySchema = entryInputSchema.extend({
  revision: z.number().int().meta({ description: 'Share revision of the last change' }),
});

export const shareSchema = z
  .object({
    shareId: uuidV4,
    ownerId: uuidV4,
    status: shareStatusSchema,
    meta: z.string().nullable().meta({ description: 'Encrypted master data; null once ended' }),
    entries: z.array(entrySchema),
    revision: z.number().int().meta({ description: 'Current revision; use as next `since`' }),
    createdAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp.nullable(),
  })
  .meta({
    examples: [
      {
        shareId: EXAMPLE_SHARE_ID,
        ownerId: EXAMPLE_OWNER_ID,
        status: 'active',
        meta: EXAMPLE_CIPHERTEXT,
        entries: [
          {
            date: '2026-11-24',
            data: EXAMPLE_CIPHERTEXT,
            updatedAt: '2026-11-24T19:30:00.000Z',
            deviceId: EXAMPLE_DEVICE_ID,
            revision: 7,
          },
        ],
        revision: 7,
        createdAt: '2026-11-01T08:00:00.000Z',
        updatedAt: '2026-11-24T19:30:01.000Z',
        endedAt: null,
      },
    ],
  });

// --- invites & readers ---

export const inviteSchema = z
  .object({
    code: z.string().meta({ description: 'One-time invite code' }),
    url: z.url().meta({
      description:
        'Invite link without the key. The app appends `#k=<share key>&v=1`; the fragment never reaches the server.',
    }),
    expiresAt: timestamp,
  })
  .meta({
    examples: [
      {
        code: 'Zq3v1mT0cX8yWb2nA5rK4g',
        url: 'https://habits.improvemess.com/invite/Zq3v1mT0cX8yWb2nA5rK4g',
        expiresAt: '2026-12-01T10:00:00.000Z',
      },
    ],
  });

export const redeemSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional().meta({
      description: 'Name the owner sees in the list of readers',
    }),
  })
  .meta({ examples: [{ displayName: 'Anna' }] });

export const redeemedSchema = z
  .object({
    shareId: uuidV4,
    readerId: uuidV4,
    readerToken: z.string().meta({
      description: 'Read-only bearer token for this share. Shown only once.',
    }),
    status: shareStatusSchema,
  })
  .meta({
    examples: [
      {
        shareId: EXAMPLE_SHARE_ID,
        readerId: EXAMPLE_READER_ID,
        readerToken: 'rt_0hX9cQm3T1yV7b…',
        status: 'active',
      },
    ],
  });

export const readersSchema = z
  .object({
    readers: z.array(
      z.object({
        readerId: uuidV4,
        displayName: z.string().nullable(),
        createdAt: timestamp,
        lastSeenAt: timestamp,
      }),
    ),
  })
  .meta({
    examples: [
      {
        readers: [
          {
            readerId: EXAMPLE_READER_ID,
            displayName: 'Anna',
            createdAt: '2026-11-20T18:00:00.000Z',
            lastSeenAt: '2026-11-24T07:12:00.000Z',
          },
        ],
      },
    ],
  });

export type ShareStatus = z.infer<typeof shareStatusSchema>;
export type EntryInput = z.infer<typeof entryInputSchema>;
