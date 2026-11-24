import { createHash, randomBytes } from 'node:crypto';

/** Prefix of tokens that owner devices use to write. */
export const DEVICE_TOKEN_PREFIX = 'dt_';
/** Prefix of read-only tokens that friends receive when redeeming an invite. */
export const READER_TOKEN_PREFIX = 'rt_';

/**
 * Hash for secrets and tokens. All of them carry at least 128 bits of
 * randomness, so a fast hash is enough: there is nothing to brute-force.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A new opaque token: prefix + 256 random bits, base64url. */
export function newToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url');
}

/** A new invite code: 128 random bits, base64url (22 characters). */
export function newInviteCode(): string {
  return randomBytes(16).toString('base64url');
}
