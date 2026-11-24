import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  createInvite,
  createOwner,
  createShare,
} from '../__tests__/harness.js';

afterEach(() => {
  delete process.env['APP_VERSION'];
});

describe('system endpoints', () => {
  it('GET /health', async () => {
    const { app } = createHarness();
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /version reads APP_VERSION', async () => {
    const { app } = createHarness();
    expect((await request(app).get('/version').expect(200)).body).toEqual({ version: 'dev' });
    process.env['APP_VERSION'] = '1.2.3';
    expect((await request(app).get('/version').expect(200)).body).toEqual({ version: '1.2.3' });
  });

  it('GET /.well-known/uhabits-server', async () => {
    const { app } = createHarness();
    const res = await request(app).get('/.well-known/uhabits-server').expect(200);
    expect(res.body).toEqual({ apiVersions: ['v1'], version: 'dev' });
  });

  it('serves the docs and the spec without auth', async () => {
    const { app } = createHarness();
    await request(app).get('/').expect(302).expect('Location', '/docs');
    const docs = await request(app).get('/docs/').expect(200);
    expect(docs.text).toContain('swagger');
    const spec = await request(app).get('/openapi.json').expect(200);
    expect(spec.body.openapi).toBe('3.1.0');
  });

  it('answers unknown routes with a JSON 404', async () => {
    const { app } = createHarness();
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({ error: 'Route not found' });
  });
});

describe('BASE_PATH', () => {
  it('mounts everything below the base path', async () => {
    const { app } = createHarness({ BASE_PATH: '/habits/' });
    await request(app).get('/habits/health').expect(200);
    await request(app).get('/habits/.well-known/uhabits-server').expect(200);
    await request(app).get('/habits').expect(302).expect('Location', '/habits/docs');
    const spec = await request(app).get('/habits/openapi.json').expect(200);
    expect(spec.body.servers).toEqual([{ url: '/habits' }]);
    await request(app).get('/health').expect(404);
    await request(app).post('/api/v1/owners').send({}).expect(404);
  });

  it('builds invite links that include the base path', async () => {
    const { app } = createHarness({ BASE_PATH: '/habits' });
    const prefixed = request.agent(app);
    // the harness helpers use unprefixed URLs, so register through the prefix by hand
    const ownerId = '5b0c3c1e-8a5f-4d7e-9a3b-2f1c6d7e8f90';
    const ownerSecret = 'ab'.repeat(32);
    await prefixed.post('/habits/api/v1/owners').send({ ownerId, ownerSecret }).expect(201);
    const device = await prefixed
      .post(`/habits/api/v1/owners/${ownerId}/devices`)
      .send({ ownerSecret, deviceId: 'c2a7e5d4-1b3f-4e6a-8d9c-0f1e2d3c4b5a' })
      .expect(201);
    const auth = bearer(device.body.deviceToken as string);
    const share = await prefixed
      .post('/habits/api/v1/shares')
      .set('Authorization', auth)
      .send({ meta: 'YQ' })
      .expect(201);
    const invite = await prefixed
      .post(`/habits/api/v1/shares/${share.body.shareId as string}/invites`)
      .set('Authorization', auth)
      .set('Host', 'example.com')
      .expect(201);
    expect(invite.body.url).toBe(`http://example.com/habits/invite/${invite.body.code as string}`);
    await prefixed.get(`/habits/invite/${invite.body.code as string}`).expect(200);
  });

  it('honours X-Forwarded-Proto behind a trusted proxy', async () => {
    const { app } = createHarness({ TRUST_PROXY: '1' });
    const owner = await createOwner(app);
    const shareId = await createShare(app, owner);
    const res = await request(app)
      .post(`/api/v1/shares/${shareId}/invites`)
      .set('Authorization', bearer(owner.deviceToken))
      .set('Host', 'habits.improvemess.com')
      .set('X-Forwarded-Proto', 'https')
      .expect(201);
    expect(res.body.url).toMatch(/^https:\/\/habits\.improvemess\.com\/invite\//);
    await createInvite(app, owner, shareId);
  });
});
