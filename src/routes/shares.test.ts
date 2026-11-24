import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  DAY,
  addReader,
  bearer,
  createHarness,
  createInvite,
  createOwner,
  createShare,
  entry,
} from '../__tests__/harness.js';

describe('shares', () => {
  it('creates a share and reads it back', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner, 'bWV0YQ');
    const res = await request(app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
    expect(res.body).toMatchObject({
      shareId,
      ownerId: owner.ownerId,
      status: 'active',
      meta: 'bWV0YQ',
      entries: [],
      revision: 1,
      endedAt: null,
    });
  });

  it('rejects meta that is not base64url', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    await request(app)
      .post('/api/v1/shares')
      .set('Authorization', bearer(owner.deviceToken))
      .send({ meta: 'not base64!' })
      .expect(400);
  });

  it('updates meta and increments the revision', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const put = await request(app)
      .put(`/api/v1/shares/${shareId}/meta`)
      .set('Authorization', bearer(owner.deviceToken))
      .send({ meta: 'bmV3' })
      .expect(200);
    expect(put.body.revision).toBe(2);
    const res = await request(app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
    expect(res.body.meta).toBe('bmV3');
  });

  it('hides shares of other owners', async () => {
    const { app } = createHarness();
    const alice = await createOwner(app);
    const bob = await createOwner(app);
    const shareId = await createShare(app, alice);
    const auth = bearer(bob.deviceToken);
    await request(app).get(`/api/v1/shares/${shareId}`).set('Authorization', auth).expect(404);
    await request(app)
      .put(`/api/v1/shares/${shareId}/meta`)
      .set('Authorization', auth)
      .send({ meta: 'eA' })
      .expect(404);
    await request(app).delete(`/api/v1/shares/${shareId}`).set('Authorization', auth).expect(404);
    await request(app).get(`/api/v1/shares/${randomUUID()}`).set('Authorization', auth).expect(404);
  });

  it('marks a share inactive without heartbeat and active again after one', async () => {
    const { app, advance } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const reader = await addReader(app, owner, shareId);
    const status = async (): Promise<string> =>
      (
        await request(app)
          .get(`/api/v1/shares/${shareId}`)
          .set('Authorization', bearer(reader.readerToken))
          .expect(200)
      ).body.status as string;

    advance(89 * DAY);
    expect(await status()).toBe('active');
    advance(1 * DAY);
    expect(await status()).toBe('inactive');
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
    expect(await status()).toBe('active');
  });
});

describe('entries', () => {
  it('stores entries and returns them incrementally with since', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const auth = bearer(owner.deviceToken);
    const first = await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', auth)
      .send({
        entries: [
          entry('2026-01-01', 'YQ', '2026-01-01T10:00:00Z', owner.deviceId),
          entry('2025-12-31', 'Yg', '2026-01-01T10:00:00Z', owner.deviceId),
        ],
      })
      .expect(200);
    expect(first.body).toEqual({ accepted: 2, ignored: 0, revision: 2 });

    const all = await request(app).get(`/api/v1/shares/${shareId}`).set('Authorization', auth);
    expect(all.body.entries.map((e: { date: string }) => e.date)).toEqual([
      '2025-12-31',
      '2026-01-01',
    ]);
    expect(all.body.entries[0]).toEqual({
      date: '2025-12-31',
      data: 'Yg',
      updatedAt: '2026-01-01T10:00:00.000Z',
      deviceId: owner.deviceId,
      revision: 2,
    });

    await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', auth)
      .send({ entries: [entry('2026-01-01', 'Yw', '2026-01-01T11:00:00Z', owner.deviceId)] })
      .expect(200);
    const since = await request(app)
      .get(`/api/v1/shares/${shareId}?since=2`)
      .set('Authorization', auth)
      .expect(200);
    expect(since.body.revision).toBe(3);
    expect(since.body.entries).toHaveLength(1);
    expect(since.body.entries[0]).toMatchObject({ date: '2026-01-01', data: 'Yw', revision: 3 });

    const none = await request(app)
      .get(`/api/v1/shares/${shareId}?since=3`)
      .set('Authorization', auth)
      .expect(200);
    expect(none.body.entries).toEqual([]);
  });

  it('rejects an invalid since', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    await request(app)
      .get(`/api/v1/shares/${shareId}?since=-1`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(400);
  });

  it('applies last writer wins per day', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const auth = bearer(owner.deviceToken);
    const otherDevice = randomUUID();
    const put = (entries: ReturnType<typeof entry>[]) =>
      request(app)
        .put(`/api/v1/shares/${shareId}/entries`)
        .set('Authorization', auth)
        .send({ entries })
        .expect(200);

    await put([entry('2026-01-01', 'bmV3ZXI', '2026-01-01T10:00:00Z', owner.deviceId)]);
    const older = await put([entry('2026-01-01', 'b2xkZXI', '2026-01-01T09:00:00Z', otherDevice)]);
    expect(older.body).toEqual({ accepted: 0, ignored: 1, revision: 2 });

    const winnerId = [owner.deviceId, otherDevice].sort()[1]!;
    const loserId = [owner.deviceId, otherDevice].sort()[0]!;
    await put([entry('2026-01-01', 'bG9zZXI', '2026-01-01T12:00:00Z', loserId)]);
    const tie = await put([entry('2026-01-01', 'd2lubmVy', '2026-01-01T12:00:00Z', winnerId)]);
    expect(tie.body.accepted).toBe(1);
    const tieAgain = await put([entry('2026-01-01', 'bG9zZXI', '2026-01-01T12:00:00Z', loserId)]);
    expect(tieAgain.body.accepted).toBe(0);

    const res = await request(app).get(`/api/v1/shares/${shareId}`).set('Authorization', auth);
    expect(res.body.entries).toEqual([
      expect.objectContaining({ data: 'd2lubmVy', deviceId: winnerId }),
    ]);
  });

  it('keeps the newest of several entries for the same day within one batch', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const auth = bearer(owner.deviceToken);
    const res = await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', auth)
      .send({
        entries: [
          entry('2026-01-01', 'Yg', '2026-01-01T11:00:00Z', owner.deviceId),
          entry('2026-01-01', 'YQ', '2026-01-01T10:00:00Z', owner.deviceId),
        ],
      })
      .expect(200);
    expect(res.body).toEqual({ accepted: 1, ignored: 1, revision: 2 });
    const share = await request(app).get(`/api/v1/shares/${shareId}`).set('Authorization', auth);
    expect(share.body.entries[0].data).toBe('Yg');
  });

  it('clamps updatedAt from the future to the server time', async () => {
    const { app, now } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const auth = bearer(owner.deviceToken);
    await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', auth)
      .send({ entries: [entry('2026-01-01', 'YQ', '2030-01-01T00:00:00Z', owner.deviceId)] })
      .expect(200);
    const res = await request(app).get(`/api/v1/shares/${shareId}`).set('Authorization', auth);
    expect(res.body.entries[0].updatedAt).toBe(new Date(now()).toISOString());
  });

  it.each([
    [{ entries: [] }],
    [
      {
        entries: [
          {
            date: '2026-13-01',
            data: 'YQ',
            updatedAt: '2026-01-01T00:00:00Z',
            deviceId: randomUUID(),
          },
        ],
      },
    ],
    [
      {
        entries: [
          { date: '2026-01-01', data: 'YQ', updatedAt: 'yesterday', deviceId: randomUUID() },
        ],
      },
    ],
    [
      {
        entries: [
          { date: '2026-01-01', data: 'YQ', updatedAt: '2026-01-01T00:00:00Z', deviceId: 'x' },
        ],
      },
    ],
    [
      {
        entries: Array.from({ length: 501 }, () =>
          entry('2026-01-01', 'YQ', '2026-01-01T00:00:00Z', randomUUID()),
        ),
      },
    ],
  ])('rejects invalid batch %#', async (body) => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', bearer(owner.deviceToken))
      .send(body)
      .expect(400);
  });
});

describe('ending a share', () => {
  it('deletes content at once and leaves a tombstone', async () => {
    const { app, db } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const auth = bearer(owner.deviceToken);
    await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', auth)
      .send({ entries: [entry('2026-01-01', 'YQ', '2026-01-01T10:00:00Z', owner.deviceId)] })
      .expect(200);
    const reader = await addReader(app, owner, shareId);
    await createInvite(app, owner, shareId);

    await request(app).delete(`/api/v1/shares/${shareId}`).set('Authorization', auth).expect(204);

    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('entries')).toBe(0);
    expect(count('invites')).toBe(0);
    const res = await request(app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(reader.readerToken))
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ended', meta: null, entries: [] });
    expect(res.body.endedAt).not.toBeNull();
    const readerRow = db.prepare('SELECT display_name FROM readers').get() as {
      display_name: string | null;
    };
    expect(readerRow.display_name).toBeNull();
  });

  it('rejects writes to an ended share with 410', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const auth = bearer(owner.deviceToken);
    await request(app).delete(`/api/v1/shares/${shareId}`).set('Authorization', auth).expect(204);
    await request(app).delete(`/api/v1/shares/${shareId}`).set('Authorization', auth).expect(410);
    await request(app)
      .put(`/api/v1/shares/${shareId}/meta`)
      .set('Authorization', auth)
      .send({ meta: 'YQ' })
      .expect(410);
    await request(app)
      .put(`/api/v1/shares/${shareId}/entries`)
      .set('Authorization', auth)
      .send({ entries: [entry('2026-01-01', 'YQ', '2026-01-01T10:00:00Z', owner.deviceId)] })
      .expect(410);
    await request(app)
      .post(`/api/v1/shares/${shareId}/invites`)
      .set('Authorization', auth)
      .expect(410);
    await request(app)
      .get(`/api/v1/shares/${shareId}/readers`)
      .set('Authorization', auth)
      .expect(410);
  });
});

describe('readers', () => {
  it('lists readers with display names and removes one', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const anna = await addReader(app, owner, shareId, 'Anna');
    const ben = await addReader(app, owner, shareId, 'Ben');
    const auth = bearer(owner.deviceToken);

    const list = await request(app)
      .get(`/api/v1/shares/${shareId}/readers`)
      .set('Authorization', auth)
      .expect(200);
    expect(list.body.readers.map((r: { displayName: string }) => r.displayName)).toEqual([
      'Anna',
      'Ben',
    ]);

    await request(app)
      .delete(`/api/v1/shares/${shareId}/readers/${anna.readerId}`)
      .set('Authorization', auth)
      .expect(204);
    await request(app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(anna.readerToken))
      .expect(401);
    await request(app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(ben.readerToken))
      .expect(200);
    await request(app)
      .delete(`/api/v1/shares/${shareId}/readers/${anna.readerId}`)
      .set('Authorization', auth)
      .expect(404);
  });

  it('lets a reader cancel their own subscription', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const reader = await addReader(app, owner, shareId);
    const auth = bearer(reader.readerToken);
    await request(app).delete('/api/v1/subscriptions/self').set('Authorization', auth).expect(204);
    await request(app).get(`/api/v1/shares/${shareId}`).set('Authorization', auth).expect(401);
  });

  it('rejects device tokens on the reader-only endpoint', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const res = await request(app)
      .delete('/api/v1/subscriptions/self')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(403);
    expect(res.body.error).toBe('This endpoint needs a reader token');
  });

  it('lets a reader read only their own share', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const mine = await createShare(app, owner);
    const other = await createShare(app, owner);
    const reader = await addReader(app, owner, mine);
    await request(app)
      .get(`/api/v1/shares/${other}`)
      .set('Authorization', bearer(reader.readerToken))
      .expect(404);
  });

  it('rejects every write with a reader token', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const reader = await addReader(app, owner, shareId);
    const auth = bearer(reader.readerToken);
    const writes = [
      request(app).post('/api/v1/shares').send({ meta: 'YQ' }),
      request(app).put(`/api/v1/shares/${shareId}/meta`).send({ meta: 'YQ' }),
      request(app)
        .put(`/api/v1/shares/${shareId}/entries`)
        .send({ entries: [entry('2026-01-01', 'YQ', '2026-01-01T10:00:00Z', randomUUID())] }),
      request(app).delete(`/api/v1/shares/${shareId}`),
      request(app).post(`/api/v1/shares/${shareId}/invites`),
      request(app).get(`/api/v1/shares/${shareId}/readers`),
      request(app).delete(`/api/v1/shares/${shareId}/readers/${reader.readerId}`),
      request(app).post('/api/v1/heartbeat'),
      request(app).delete(`/api/v1/owners/${owner.ownerId}/devices/${owner.deviceId}`),
    ];
    for (const write of writes) {
      const res = await write.set('Authorization', auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Reader tokens are read-only' });
    }
    const share = await request(app)
      .get(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
    expect(share.body).toMatchObject({ status: 'active', meta: 'bWV0YQ', revision: 1 });
  });
});
