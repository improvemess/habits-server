import { timingSafeEqual } from 'node:crypto';
import { type Clock } from '../clock.js';
import { type Database, transaction } from '../db/database.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import { DEVICE_TOKEN_PREFIX, READER_TOKEN_PREFIX, hashSecret, newToken } from '../secrets.js';
import { type Auth, type DeviceAuth } from './auth.js';

interface OwnerRow {
  id: string;
  secret_hash: string;
  created_at: number;
}

interface DeviceRow {
  owner_id: string;
  id: string;
}

interface ReaderRow {
  id: string;
  share_id: string;
}

export interface CreatedOwner {
  ownerId: string;
  createdAt: number;
  /** false if the owner already existed with the same secret (idempotent retry). */
  created: boolean;
}

export interface RegisteredDevice {
  ownerId: string;
  deviceId: string;
  deviceToken: string;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Owner identities, their devices and token authentication. */
export class OwnerService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  public createOwner(ownerId: string, ownerSecret: string): CreatedOwner {
    const secretHash = hashSecret(ownerSecret);
    return transaction(this.db, () => {
      const existing = this.findOwner(ownerId);
      if (existing !== undefined) {
        if (!sameHash(existing.secret_hash, secretHash)) {
          throw conflict('Owner already exists with a different secret');
        }
        return { ownerId, createdAt: existing.created_at, created: false };
      }
      const now = this.clock();
      this.db
        .prepare(
          'INSERT INTO owners (id, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
        )
        .run(ownerId, secretHash, now, now);
      return { ownerId, createdAt: now, created: true };
    });
  }

  /**
   * Issues a new token for the device. Registering an already known device
   * again replaces its token (e.g. after reinstalling the app).
   */
  public registerDevice(
    ownerId: string,
    ownerSecret: string,
    deviceId: string,
    name: string | undefined,
  ): RegisteredDevice {
    const owner = this.findOwner(ownerId);
    if (owner === undefined) throw notFound('Owner not found');
    if (!sameHash(owner.secret_hash, hashSecret(ownerSecret))) {
      throw unauthorized('Wrong owner secret');
    }
    const deviceToken = newToken(DEVICE_TOKEN_PREFIX);
    const now = this.clock();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO devices (owner_id, id, token_hash, name, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, id) DO UPDATE SET
             token_hash = excluded.token_hash,
             name = coalesce(excluded.name, devices.name),
             last_seen_at = excluded.last_seen_at`,
        )
        .run(ownerId, deviceId, hashSecret(deviceToken), name ?? null, now, now);
      this.touchOwner(ownerId, now);
    });
    return { ownerId, deviceId, deviceToken };
  }

  /** Revokes a device of the authenticated owner; its token stops working at once. */
  public revokeDevice(auth: DeviceAuth, ownerId: string, deviceId: string): void {
    if (auth.ownerId !== ownerId) throw notFound('Device not found');
    const result = this.db
      .prepare('DELETE FROM devices WHERE owner_id = ? AND id = ?')
      .run(ownerId, deviceId);
    if (result.changes === 0) throw notFound('Device not found');
  }

  /** Records that the device is alive. Authentication already updated `lastSeen`. */
  public heartbeat(auth: DeviceAuth): { deviceId: string; lastSeenAt: number } {
    return { deviceId: auth.deviceId, lastSeenAt: this.clock() };
  }

  /** Resolves a bearer token and records the activity; undefined if unknown. */
  public authenticate(token: string): Auth | undefined {
    const now = this.clock();
    if (token.startsWith(DEVICE_TOKEN_PREFIX)) {
      const device = this.db
        .prepare('SELECT owner_id, id FROM devices WHERE token_hash = ?')
        .get(hashSecret(token)) as DeviceRow | undefined;
      if (device === undefined) return undefined;
      this.db
        .prepare('UPDATE devices SET last_seen_at = ? WHERE owner_id = ? AND id = ?')
        .run(now, device.owner_id, device.id);
      this.touchOwner(device.owner_id, now);
      return { kind: 'device', ownerId: device.owner_id, deviceId: device.id };
    }
    if (token.startsWith(READER_TOKEN_PREFIX)) {
      const reader = this.db
        .prepare('SELECT id, share_id FROM readers WHERE token_hash = ?')
        .get(hashSecret(token)) as ReaderRow | undefined;
      if (reader === undefined) return undefined;
      this.db.prepare('UPDATE readers SET last_seen_at = ? WHERE id = ?').run(now, reader.id);
      return { kind: 'reader', readerId: reader.id, shareId: reader.share_id };
    }
    return undefined;
  }

  private findOwner(ownerId: string): OwnerRow | undefined {
    return this.db
      .prepare('SELECT id, secret_hash, created_at FROM owners WHERE id = ?')
      .get(ownerId) as OwnerRow | undefined;
  }

  private touchOwner(ownerId: string, now: number): void {
    this.db.prepare('UPDATE owners SET last_seen_at = ? WHERE id = ?').run(now, ownerId);
  }
}
