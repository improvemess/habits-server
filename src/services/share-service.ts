import { randomUUID } from 'node:crypto';
import { type Clock } from '../clock.js';
import { type Retention } from '../config.js';
import { type Database, transaction } from '../db/database.js';
import { gone, notFound } from '../errors.js';
import { READER_TOKEN_PREFIX, hashSecret, newInviteCode, newToken } from '../secrets.js';
import { type EntryInput, type ShareStatus } from '../schemas.js';
import { type Auth, type DeviceAuth, type ReaderAuth } from './auth.js';

interface ShareRow {
  id: string;
  owner_id: string;
  meta: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  owner_last_seen_at: number;
}

interface EntryRow {
  date: string;
  data: string;
  updated_at: number;
  device_id: string;
  revision: number;
}

interface InviteRow {
  share_id: string;
  expires_at: number;
  redeemed_at: number | null;
}

export interface ShareView {
  id: string;
  ownerId: string;
  status: ShareStatus;
  meta: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  entries: {
    date: string;
    data: string;
    updatedAt: number;
    deviceId: string;
    revision: number;
  }[];
}

export interface CreatedInvite {
  code: string;
  expiresAt: number;
}

export interface Redemption {
  shareId: string;
  readerId: string;
  readerToken: string;
  status: ShareStatus;
}

export interface ReaderView {
  readerId: string;
  displayName: string | null;
  createdAt: number;
  lastSeenAt: number;
}

/** What the invite landing page may show. Never contains share content. */
export type InviteState = 'valid' | 'redeemed' | 'expired' | 'ended' | 'unknown';

const SHARE_SELECT = `
  SELECT s.id, s.owner_id, s.meta, s.revision, s.created_at, s.updated_at, s.ended_at,
         o.last_seen_at AS owner_last_seen_at
  FROM shares s JOIN owners o ON o.id = s.owner_id`;

/** Shares, their entries, invites and readers. Content is ciphertext only. */
export class ShareService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly retention: Retention,
  ) {}

  public create(
    auth: DeviceAuth,
    meta: string,
  ): { id: string; status: ShareStatus; revision: number } {
    const id = randomUUID();
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO shares (id, owner_id, meta, revision, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(id, auth.ownerId, meta, now, now);
    return { id, status: 'active', revision: 1 };
  }

  public updateMeta(auth: DeviceAuth, shareId: string, meta: string): number {
    return transaction(this.db, () => {
      const share = this.ownedOpenShare(auth, shareId);
      const revision = share.revision + 1;
      this.db
        .prepare('UPDATE shares SET meta = ?, revision = ?, updated_at = ? WHERE id = ?')
        .run(meta, revision, this.clock(), shareId);
      return revision;
    });
  }

  /**
   * Stores entries with last writer wins per day: an entry replaces the stored
   * one only if its `updatedAt` is newer (ties are broken by `deviceId`).
   * Timestamps from the future are clamped to the server time, so a device
   * with a wrong clock cannot pin an entry forever.
   */
  public putEntries(
    auth: DeviceAuth,
    shareId: string,
    entries: EntryInput[],
  ): { accepted: number; ignored: number; revision: number } {
    return transaction(this.db, () => {
      const share = this.ownedOpenShare(auth, shareId);
      const now = this.clock();
      const revision = share.revision + 1;
      const upsert = this.db.prepare(
        `INSERT INTO entries (share_id, date, data, updated_at, device_id, revision)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (share_id, date) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at,
           device_id = excluded.device_id,
           revision = excluded.revision
         WHERE excluded.updated_at > entries.updated_at
            OR (excluded.updated_at = entries.updated_at AND excluded.device_id > entries.device_id)`,
      );
      let accepted = 0;
      for (const entry of entries) {
        const updatedAt = Math.min(Date.parse(entry.updatedAt), now);
        const result = upsert.run(
          shareId,
          entry.date,
          entry.data,
          updatedAt,
          entry.deviceId,
          revision,
        );
        accepted += Number(result.changes);
      }
      if (accepted === 0) return { accepted, ignored: entries.length, revision: share.revision };
      this.db
        .prepare('UPDATE shares SET revision = ?, updated_at = ? WHERE id = ?')
        .run(revision, now, shareId);
      return { accepted, ignored: entries.length - accepted, revision };
    });
  }

  /**
   * Ends the share: meta, entries and invites are deleted at once; a tombstone
   * (id, end date) stays so friends learn that it ended. Readers keep their
   * token until the tombstone is cleaned up, but lose their display name.
   */
  public end(auth: DeviceAuth, shareId: string): void {
    transaction(this.db, () => {
      this.ownedOpenShare(auth, shareId);
      this.endShare(shareId, this.clock());
    });
  }

  public get(auth: Auth, shareId: string, since: number): ShareView {
    const share = this.findShare(shareId);
    if (share === undefined || !this.mayRead(auth, share)) throw notFound('Share not found');
    const entries =
      share.ended_at === null
        ? (this.db
            .prepare(
              `SELECT date, data, updated_at, device_id, revision FROM entries
               WHERE share_id = ? AND revision > ? ORDER BY date`,
            )
            .all(shareId, since) as unknown as EntryRow[])
        : [];
    return {
      id: share.id,
      ownerId: share.owner_id,
      status: this.status(share),
      meta: share.meta,
      revision: share.revision,
      createdAt: share.created_at,
      updatedAt: share.updated_at,
      endedAt: share.ended_at,
      entries: entries.map((row) => ({
        date: row.date,
        data: row.data,
        updatedAt: row.updated_at,
        deviceId: row.device_id,
        revision: row.revision,
      })),
    };
  }

  /** Creates a one-time invite that expires after the configured TTL. */
  public createInvite(auth: DeviceAuth, shareId: string): CreatedInvite {
    this.ownedOpenShare(auth, shareId);
    const code = newInviteCode();
    const now = this.clock();
    const expiresAt = now + this.retention.inviteTtl;
    this.db
      .prepare(
        'INSERT INTO invites (code_hash, share_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(hashSecret(code), shareId, now, expiresAt);
    return { code, expiresAt };
  }

  public inviteState(code: string): InviteState {
    const invite = this.findInvite(code);
    if (invite === undefined) return 'unknown';
    const share = this.findShare(invite.share_id);
    if (share === undefined || share.ended_at !== null) return 'ended';
    if (invite.redeemed_at !== null) return 'redeemed';
    if (invite.expires_at <= this.clock()) return 'expired';
    return 'valid';
  }

  /** Exchanges a valid invite for a new read-only token. The invite is used up. */
  public redeem(code: string, displayName: string | undefined): Redemption {
    return transaction(this.db, () => {
      const invite = this.findInvite(code);
      if (invite === undefined) throw notFound('Invite not found');
      const share = this.findShare(invite.share_id);
      if (share === undefined || share.ended_at !== null) throw gone('Share has ended');
      if (invite.redeemed_at !== null) throw gone('Invite has already been redeemed');
      const now = this.clock();
      if (invite.expires_at <= now) throw gone('Invite has expired');

      this.db
        .prepare('UPDATE invites SET redeemed_at = ? WHERE code_hash = ?')
        .run(now, hashSecret(code));
      const readerId = randomUUID();
      const readerToken = newToken(READER_TOKEN_PREFIX);
      this.db
        .prepare(
          `INSERT INTO readers (id, share_id, token_hash, display_name, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(readerId, share.id, hashSecret(readerToken), displayName ?? null, now, now);
      return { shareId: share.id, readerId, readerToken, status: this.status(share) };
    });
  }

  public listReaders(auth: DeviceAuth, shareId: string): ReaderView[] {
    this.ownedOpenShare(auth, shareId);
    const rows = this.db
      .prepare(
        `SELECT id, display_name, created_at, last_seen_at FROM readers
         WHERE share_id = ? ORDER BY created_at`,
      )
      .all(shareId) as unknown as {
      id: string;
      display_name: string | null;
      created_at: number;
      last_seen_at: number;
    }[];
    return rows.map((row) => ({
      readerId: row.id,
      displayName: row.display_name,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  public removeReader(auth: DeviceAuth, shareId: string, readerId: string): void {
    this.ownedOpenShare(auth, shareId);
    const result = this.db
      .prepare('DELETE FROM readers WHERE id = ? AND share_id = ?')
      .run(readerId, shareId);
    if (result.changes === 0) throw notFound('Reader not found');
  }

  /** The friend cancels their own subscription; the token stops working. */
  public unsubscribe(auth: ReaderAuth): void {
    this.db.prepare('DELETE FROM readers WHERE id = ?').run(auth.readerId);
  }

  /** Turns a share into a tombstone. Used by `end` and by the cleanup job. */
  public endShare(shareId: string, now: number): void {
    this.db.prepare('DELETE FROM entries WHERE share_id = ?').run(shareId);
    this.db.prepare('DELETE FROM invites WHERE share_id = ?').run(shareId);
    this.db.prepare('UPDATE readers SET display_name = NULL WHERE share_id = ?').run(shareId);
    this.db
      .prepare(
        'UPDATE shares SET meta = NULL, ended_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      )
      .run(now, now, shareId);
  }

  private status(share: ShareRow): ShareStatus {
    if (share.ended_at !== null) return 'ended';
    const idleFor = this.clock() - share.owner_last_seen_at;
    return idleFor >= this.retention.shareInactiveAfter ? 'inactive' : 'active';
  }

  private mayRead(auth: Auth, share: ShareRow): boolean {
    switch (auth.kind) {
      case 'device':
        return share.owner_id === auth.ownerId;
      case 'reader':
        return share.id === auth.shareId;
    }
  }

  /** The share, if it belongs to the device's owner and has not ended. */
  private ownedOpenShare(auth: DeviceAuth, shareId: string): ShareRow {
    const share = this.findShare(shareId);
    if (share?.owner_id !== auth.ownerId) throw notFound('Share not found');
    if (share.ended_at !== null) throw gone('Share has ended');
    return share;
  }

  private findShare(shareId: string): ShareRow | undefined {
    return this.db.prepare(`${SHARE_SELECT} WHERE s.id = ?`).get(shareId) as ShareRow | undefined;
  }

  private findInvite(code: string): InviteRow | undefined {
    return this.db
      .prepare('SELECT share_id, expires_at, redeemed_at FROM invites WHERE code_hash = ?')
      .get(hashSecret(code)) as InviteRow | undefined;
  }
}
