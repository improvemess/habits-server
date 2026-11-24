import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  DAY,
  bearer,
  createHarness,
  createInvite,
  createOwner,
  createShare,
} from '../__tests__/harness.js';

describe('invites', () => {
  it('returns an invite URL on the request origin', async () => {
    const { app, now } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const res = await request(app)
      .post(`/api/v1/shares/${shareId}/invites`)
      .set('Authorization', bearer(owner.deviceToken))
      .set('Host', 'habits.example.org')
      .expect(201);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.body.url).toBe(`http://habits.example.org/invite/${res.body.code as string}`);
    expect(res.body.expiresAt).toBe(new Date(now() + 7 * DAY).toISOString());
  });

  it('uses PUBLIC_URL for invite links when configured', async () => {
    const { app } = createHarness({ PUBLIC_URL: 'https://example.com/habits/' });
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const res = await request(app)
      .post(`/api/v1/shares/${shareId}/invites`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(201);
    expect(res.body.url).toBe(`https://example.com/habits/invite/${res.body.code as string}`);
  });

  it('can be redeemed exactly once', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const code = await createInvite(app, owner, shareId);
    const res = await request(app)
      .post(`/api/v1/invites/${code}/redeem`)
      .send({ displayName: 'Anna' })
      .expect(201);
    expect(res.body).toMatchObject({ shareId, status: 'active' });
    expect(res.body.readerToken).toMatch(/^rt_/);
    const again = await request(app).post(`/api/v1/invites/${code}/redeem`).send({}).expect(410);
    expect(again.body.error).toMatch(/already been redeemed/);
  });

  it('works without a display name and without body', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const code = await createInvite(app, owner, shareId);
    await request(app).post(`/api/v1/invites/${code}/redeem`).expect(201);
    const list = await request(app)
      .get(`/api/v1/shares/${shareId}/readers`)
      .set('Authorization', bearer(owner.deviceToken));
    expect(list.body.readers[0].displayName).toBeNull();
  });

  it('expires after 7 days', async () => {
    const { app, advance } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const code = await createInvite(app, owner, shareId);
    advance(7 * DAY);
    const res = await request(app).post(`/api/v1/invites/${code}/redeem`).send({}).expect(410);
    expect(res.body.error).toBe('Invite has expired');
  });

  it('cannot be redeemed after the share ended', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const code = await createInvite(app, owner, shareId);
    await request(app)
      .delete(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(204);
    await request(app).post(`/api/v1/invites/${code}/redeem`).send({}).expect(404);
  });

  it('returns 404 for unknown codes and rate limits them', async () => {
    const { app } = createHarness({ RATE_LIMIT_SECRETS: '2' });
    await request(app).post('/api/v1/invites/unknown/redeem').send({}).expect(404);
    await request(app).post('/api/v1/invites/unknown/redeem').send({}).expect(404);
    await request(app).post('/api/v1/invites/unknown/redeem').send({}).expect(429);
  });

  it('rejects a too long display name', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const code = await createInvite(app, owner, shareId);
    await request(app)
      .post(`/api/v1/invites/${code}/redeem`)
      .send({ displayName: 'x'.repeat(101) })
      .expect(400);
  });
});

describe('GET /invite/{code}', () => {
  it('shows a landing page with the open-in-app script for a valid invite', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner, 'c2VjcmV0LW5hbWU');
    const code = await createInvite(app, owner, shareId);
    const res = await request(app)
      .get(`/invite/${code}`)
      .set('Accept-Language', 'de-DE,de;q=0.9')
      .expect(200)
      .expect('Content-Type', /text\/html/);
    expect(res.text).toContain('In Loop öffnen');
    expect(res.text).toContain('uhabits://invite?');
    expect(res.text).toContain(JSON.stringify(code));
    expect(res.text).not.toContain('c2VjcmV0LW5hbWU');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const nonce = /script nonce="([^"]+)"/.exec(res.text)?.[1];
    expect(res.headers['content-security-policy']).toContain(`script-src 'nonce-${nonce!}'`);
  });

  it('answers in English by default', async () => {
    const { app } = createHarness();
    const owner = await createOwner(app);
    const code = await createInvite(app, owner, await createShare(app, owner));
    const res = await request(app).get(`/invite/${code}`).expect(200);
    expect(res.text).toContain('Open in Loop');
  });

  it('shows redeemed, expired, ended and unknown invites without the script', async () => {
    const { app, advance } = createHarness();
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const lang = { 'Accept-Language': 'de' };

    const redeemed = await createInvite(app, owner, shareId);
    await request(app).post(`/api/v1/invites/${redeemed}/redeem`).send({}).expect(201);
    const page = await request(app).get(`/invite/${redeemed}`).set(lang).expect(410);
    expect(page.text).toContain('bereits eingelöst');
    expect(page.text).not.toContain('<script');

    const expired = await createInvite(app, owner, shareId);
    advance(8 * DAY);
    expect((await request(app).get(`/invite/${expired}`).set(lang).expect(410)).text).toContain(
      'abgelaufen',
    );

    const open = await createInvite(app, owner, shareId);
    await request(app)
      .delete(`/api/v1/shares/${shareId}`)
      .set('Authorization', bearer(owner.deviceToken))
      .expect(204);
    // ending a share deletes its invites, so the code is unknown now
    expect((await request(app).get(`/invite/${open}`).set(lang).expect(404)).text).toContain(
      'gibt es nicht',
    );
    await request(app).get('/invite/%3Cscript%3E').expect(404);
  });
});
