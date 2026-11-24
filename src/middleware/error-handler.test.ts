import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from './error-handler.js';

function appThrowing(err: unknown): express.Application {
  const app = express();
  app.get('/', () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('hides details of unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(appThrowing(new Error('db password is hunter2')))
      .get('/')
      .expect(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('uses statusCode and non-Error values', async () => {
    const res = await request(appThrowing({ statusCode: 413 }))
      .get('/')
      .expect(413);
    expect(res.body).toEqual({ error: 'Request failed' });
  });
});
