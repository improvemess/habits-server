import { type Clock } from '../clock.js';
import { type Retention } from '../config.js';
import { type Database, transaction } from '../db/database.js';
import { type ShareService } from './share-service.js';

/** Grace period before an owner without devices and shares is removed. */
const OWNER_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  tombstonesDeleted: number;
  sharesEnded: number;
  readersDeleted: number;
  invitesDeleted: number;
  devicesDeleted: number;
  ownersDeleted: number;
}

/**
 * Applies the retention rules. Decides only by timestamps, never by content:
 *
 * - ended shares: content is already gone; the tombstone goes after `tombstone`
 * - no heartbeat from any owner device for `shareDeleteAfter`: the share ends
 *   (status `inactive` already after `shareInactiveAfter`, computed on read)
 * - reader tokens not used for `reader`: deleted
 * - invites past their expiry: deleted
 * - device tokens not used for `device`: deleted
 * - owners with neither devices nor shares: deleted
 */
export function runCleanup(
  db: Database,
  shares: ShareService,
  retention: Retention,
  now: number,
): CleanupResult {
  return transaction(db, () => {
    const stale = db
      .prepare(
        `SELECT s.id FROM shares s JOIN owners o ON o.id = s.owner_id
         WHERE s.ended_at IS NULL AND o.last_seen_at <= ?`,
      )
      .all(now - retention.shareDeleteAfter) as { id: string }[];
    for (const share of stale) shares.endShare(share.id, now);

    const tombstones = db
      .prepare('DELETE FROM shares WHERE ended_at IS NOT NULL AND ended_at <= ?')
      .run(now - retention.tombstone);
    const readers = db
      .prepare('DELETE FROM readers WHERE last_seen_at <= ?')
      .run(now - retention.reader);
    const invites = db.prepare('DELETE FROM invites WHERE expires_at <= ?').run(now);
    const devices = db
      .prepare('DELETE FROM devices WHERE last_seen_at <= ?')
      .run(now - retention.device);
    const owners = db
      .prepare(
        `DELETE FROM owners
         WHERE created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.owner_id = owners.id)
           AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.owner_id = owners.id)`,
      )
      .run(now - OWNER_GRACE_MS);

    return {
      tombstonesDeleted: Number(tombstones.changes),
      sharesEnded: stale.length,
      readersDeleted: Number(readers.changes),
      invitesDeleted: Number(invites.changes),
      devicesDeleted: Number(devices.changes),
      ownersDeleted: Number(owners.changes),
    };
  });
}

/** Runs the cleanup now and then every `interval` ms. Returns a stop function. */
export function scheduleCleanup(
  db: Database,
  shares: ShareService,
  retention: Retention,
  clock: Clock,
  interval: number,
): () => void {
  const run = (): void => {
    try {
      const result = runCleanup(db, shares, retention, clock());
      console.log('Cleanup finished', JSON.stringify(result));
    } catch (err) {
      console.error('Cleanup failed', err);
    }
  };
  run();
  const timer = setInterval(run, interval);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
