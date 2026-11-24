import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAY,
  addReader,
  bearer,
  createHarness,
  createInvite,
  createOwner,
  createShare,
  type Harness,
} from '../__tests__/harness.js';
import { runCleanup, scheduleCleanup } from './cleanup.js';

const cleanup = (h: Harness) => runCleanup(h.db, h.services.shares, h.config.retention, h.now());
const count = (h: Harness, table: string): number =>
  (h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cleanup', () => {
  it('deletes the tombstone of an ended share after 30 days', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    const shareId = await createShare(h.app, owner);
    const reader = await addReader(h.app, owner, shareId);
    await request(h.app)
      .delete(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(204);

    h.advance(30 * DAY - 1);
    expect(cleanup(h).tombstonesDeleted).toBe(0);
    await request(h.app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(reader.readerToken))
      .expect(200);

    h.advance(1);
    expect(cleanup(h).tombstonesDeleted).toBe(1);
    expect(count(h, 'shares')).toBe(0);
    expect(count(h, 'readers')).toBe(0);
    await request(h.app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(reader.readerToken))
      .expect(401);
  });

  it('ends shares after 12 months without heartbeat', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    const shareId = await createShare(h.app, owner);
    const reader = await addReader(h.app, owner, shareId);

    h.advance(364 * DAY);
    // the reader keeps polling, which must not keep the share alive
    await request(h.app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(reader.readerToken))
      .expect(200);
    expect(cleanup(h).sharesEnded).toBe(0);

    h.advance(DAY);
    const result = cleanup(h);
    expect(result.sharesEnded).toBe(1);
    expect(result.devicesDeleted).toBe(1);
    const res = await request(h.app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(reader.readerToken))
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ended', meta: null });

    // the owner stays as long as the tombstone exists, then goes too
    expect(count(h, 'owners')).toBe(1);
    h.advance(30 * DAY);
    const later = cleanup(h);
    expect(later.tombstonesDeleted).toBe(1);
    expect(later.ownersDeleted).toBe(1);
    expect(count(h, 'owners')).toBe(0);
  });

  it('keeps shares whose owner sends heartbeats', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    await createShare(h.app, owner);
    for (let week = 0; week < 60; week++) {
      h.advance(7 * DAY);
      await request(h.app)
        .post('/api/v1/heartbeat')
        .set('Authorization', bearer(owner.deviceToken))
        .expect(200);
      cleanup(h);
    }
    expect(count(h, 'shares')).toBe(1);
    expect(count(h, 'devices')).toBe(1);
  });

  it('deletes reader tokens not used for 6 months', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    const shareId = await createShare(h.app, owner);
    const active = await addReader(h.app, owner, shareId, 'active');
    await addReader(h.app, owner, shareId, 'idle');

    h.advance(100 * DAY);
    await request(h.app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(active.readerToken))
      .expect(200);
    h.advance(80 * DAY);
    expect(cleanup(h).readersDeleted).toBe(1);
    const rows = h.db.prepare('SELECT display_name FROM readers').all();
    expect(rows).toEqual([{ display_name: 'active' }]);
  });

  it('deletes invites after they expire', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    const shareId = await createShare(h.app, owner);
    await createInvite(h.app, owner, shareId);
    const redeemed = await createInvite(h.app, owner, shareId);
    await request(h.app).post(`/api/v1/invites/${redeemed}/redeem`).send({}).expect(201);

    h.advance(7 * DAY - 1);
    expect(cleanup(h).invitesDeleted).toBe(0);
    h.advance(1);
    expect(cleanup(h).invitesDeleted).toBe(2);
  });

  it('deletes inactive devices after 12 months and keeps the owner while one is active', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    h.advance(200 * DAY);
    const second = await request(h.app)
      .post(`/api/v1/owners/${owner.ownerId}/devices`)
      .send({ ownerSecret: owner.ownerSecret, deviceId: '0d1c2b3a-4f5e-4d6c-8b7a-9f8e7d6c5b4a' })
      .expect(201);
    h.advance(165 * DAY);

    const result = cleanup(h);
    expect(result.devicesDeleted).toBe(1);
    expect(result.ownersDeleted).toBe(0);
    await request(h.app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(second.body.deviceToken as string))
      .expect(200);
    await request(h.app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(401);
  });

  it('deletes owners without devices and shares after a grace day', async () => {
    const h = createHarness();
    const owner = await createOwner(h.app);
    await request(h.app)
      .delete(`/api/v1/owners/${owner.ownerId}/devices/${owner.deviceId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(204);
    expect(cleanup(h).ownersDeleted).toBe(0);
    h.advance(DAY);
    expect(cleanup(h).ownersDeleted).toBe(1);
  });

  it('honours configured retention periods', async () => {
    const h = createHarness({ TOMBSTONE_RETENTION_DAYS: '2', INVITE_TTL_DAYS: '1' });
    const owner = await createOwner(h.app);
    const shareId = await createShare(h.app, owner);
    await createInvite(h.app, owner, await createShare(h.app, owner));
    await request(h.app)
      .delete(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(204);
    h.advance(DAY);
    expect(cleanup(h).invitesDeleted).toBe(1);
    h.advance(DAY);
    expect(cleanup(h).tombstonesDeleted).toBe(1);
  });
});

describe('scheduleCleanup', () => {
  it('runs at once and then periodically until stopped', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const stop = scheduleCleanup(h.db, h.services.shares, h.config.retention, h.now, 1000);
      expect(log).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2500);
      expect(log).toHaveBeenCalledTimes(3);
      stop();
      vi.advanceTimersByTime(5000);
      expect(log).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs failures instead of crashing', () => {
    const h = createHarness();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.db.close();
    const stop = scheduleCleanup(h.db, h.services.shares, h.config.retention, h.now, 1000);
    stop();
    expect(error).toHaveBeenCalledWith('Cleanup failed', expect.any(Error));
  });
});
