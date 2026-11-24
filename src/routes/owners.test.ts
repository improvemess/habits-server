import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DAY, START, bearer, createHarness, createOwner } from '../__tests__/harness.js';

const secret = (): string => randomBytes(32).toString('hex');

describe('POST /api/v1/owners', () => {
  it('creates an owner and stores only a hash of the secret', async () => {
    const { app, db } = createHarness();
    const ownerId = randomUUID();
    const ownerSecret = secret();
    const res = await request(app)
      .post('/api/v1/owners')
      .send({ ownerId, ownerSecret })
      .expect(201);
    expect(res.body).toEqual({ ownerId, createdAt: new Date(START).toISOString() });
    const row = db.prepare('SELECT secret_hash FROM owners WHERE id = ?').get(ownerId) as {
      secret_hash: string;
    };
    expect(row.secret_hash).not.toContain(ownerSecret);
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent with the same secret', async () => {
    const { app } = createHarness();
    const body = { ownerId: randomUUID(), ownerSecret: secret() };
    await request(app).post('/api/v1/owners').send(body).expect(201);
    await request(app).post('/api/v1/owners').send(body).expect(200);
  });

  it('rejects a different secret for an existing owner', async () => {
    const { app } = createHarness();
    const ownerId = randomUUID();
    await request(app).post('/api/v1/owners').send({ ownerId, ownerSecret: secret() }).expect(201);
    const res = await request(app)
      .post('/api/v1/owners')
      .send({ ownerId, ownerSecret: secret() })
      .expect(409);
    expect(res.body.error).toMatch(/different secret/);
  });

  it.each([
    [{ ownerId: 'not-a-uuid', ownerSecret: 'ab'.repeat(32) }],
    [{ ownerId: randomUUID(), ownerSecret: 'AB'.repeat(32) }],
    [{ ownerId: randomUUID(), ownerSecret: 'ab' }],
    [{}],
  ])('rejects invalid input %j', async (body) => {
    const { app } = createHarness();
    const res = await request(app).post('/api/v1/owners').send(body).expect(400);
    expect(res.body.error).toMatch(/^Invalid request/);
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = createHarness();
    await request(app)
      .post('/api/v1/owners')
      .set('Content-Type', 'application/json')
      .send('{"ownerId":')
      .expect(400);
  });

  it('rate limits failed attempts', async () => {
    const { app } = createHarness({ RATE_LIMIT_SECRETS: '2' });
    const ownerId = randomUUID();
    await request(app).post('/api/v1/owners').send({ ownerId, ownerSecret: secret() }).expect(201);
    await request(app).post('/api/v1/owners').send({ ownerId, ownerSecret: secret() }).expect(409);
    await request(app).post('/api/v1/owners').send({ ownerId, ownerSecret: secret() }).expect(409);
    const res = await request(app)
      .post('/api/v1/owners')
      .send({ ownerId, ownerSecret: secret() })
      .expect(429);
    expect(res.body.error).toMatch(/Too many requests/);
  });

  it('applies the general API rate limit', async () => {
    const { app } = createHarness({ RATE_LIMIT_API: '1' });
    await request(app).post('/api/v1/heartbeat').expect(401);
    await request(app).post('/api/v1/heartbeat').expect(429);
  });
});

describe('POST /api/v1/owners/{ownerId}/devices', () => {
  it('issues a device token that authenticates', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    expect(owner.deviceToken).toMatch(/^dt_[A-Za-z0-9_-]{43}$/);
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
  });

  it('gives every device its own token', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const res = await request(app)
      .post(`/api/v1/owners/${owner.ownerId}/devices`)
      .send({ ownerSecret: owner.ownerSecret, deviceId: randomUUID() })
      .expect(201);
    expect(res.body.deviceToken).not.toBe(owner.deviceToken);
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
  });

  it('replaces the token when the same device registers again', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const res = await request(app)
      .post(`/api/v1/owners/${owner.ownerId}/devices`)
      .send({ ownerSecret: owner.ownerSecret, deviceId: owner.deviceId })
      .expect(201);
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(401);
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(res.body.deviceToken as string))
      .expect(200);
  });

  it('rejects a wrong secret', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    await request(app)
      .post(`/api/v1/owners/${owner.ownerId}/devices`)
      .send({ ownerSecret: secret(), deviceId: randomUUID() })
      .expect(401);
  });

  it('returns 404 for an unknown owner', async () => {
    const { app } = createHarness();
    await request(app)
      .post(`/api/v1/owners/${randomUUID()}/devices`)
      .send({ ownerSecret: secret(), deviceId: randomUUID() })
      .expect(404);
  });

  it('rate limits wrong secrets', async () => {
    const { app } = createHarness({ RATE_LIMIT_SECRETS: '1' });
    const ownerId = randomUUID();
    await request(app).post('/api/v1/owners').send({ ownerId, ownerSecret: secret() }).expect(201);
    const attempt = () =>
      request(app)
        .post(`/api/v1/owners/${ownerId}/devices`)
        .send({ ownerSecret: secret(), deviceId: randomUUID() });
    await attempt().expect(401);
    await attempt().expect(429);
  });
});

describe('DELETE /api/v1/owners/{ownerId}/devices/{deviceId}', () => {
  it('revokes another device of the same owner', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const second = await request(app)
      .post(`/api/v1/owners/${owner.ownerId}/devices`)
      .send({ ownerSecret: owner.ownerSecret, deviceId: randomUUID() })
      .expect(201);
    await request(app)
      .delete(`/api/v1/owners/${owner.ownerId}/devices/${second.body.deviceId as string}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(204);
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(second.body.deviceToken as string))
      .expect(401);
  });

  it('does not touch devices of other owners', async () => {
    const { app } = createHarness();
    const alice = await createOwner(app);
    const bob = await createOwner(app);
    await request(app)
      .delete(`/api/v1/owners/${bob.ownerId}/devices/${bob.deviceId}`)
      .set('Authorization', bearer(alice.deviceToken))
      .expect(404);
    await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(bob.deviceToken))
      .expect(200);
  });

  it('returns 404 for an unknown device', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    await request(app)
      .delete(`/api/v1/owners/${owner.ownerId}/devices/${randomUUID()}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(404);
  });
});

describe('POST /api/v1/heartbeat', () => {
  it('updates lastSeen of device and owner', async () => {
    const { app, db, advance, now } = createHarness();
    const owner = await createOwner(app);
    advance(3 * DAY);
    const res = await request(app)
      .post('/api/v1/heartbeat')
      .set('Authorization', bearer(owner.deviceToken))
      .expect(200);
    expect(res.body).toEqual({
      deviceId: owner.deviceId,
      lastSeenAt: new Date(now()).toISOString(),
    });
    const device = db.prepare('SELECT last_seen_at FROM devices').get() as { last_seen_at: number };
    const ownerRow = db.prepare('SELECT last_seen_at FROM owners').get() as {
      last_seen_at: number;
    };
    expect(device.last_seen_at).toBe(now());
    expect(ownerRow.last_seen_at).toBe(now());
  });

  it.each([undefined, 'Bearer', 'Bearer nope', 'Bearer dt_unknown', 'Basic abc'])(
    'rejects authorization %s',
    async (header) => {
      const { app } = createHarness();
      const req = request(app).post('/api/v1/heartbeat');
      if (header !== undefined) void req.set('Authorization', header);
      const res = await req.expect(401);
      expect(res.body).toEqual({ error: 'Missing or invalid token' });
    },
  );
});
