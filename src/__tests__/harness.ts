import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { type Application } from 'express';
import { createApp, createServices, type Services } from '../app.js';
import { type Config, loadConfig } from '../config.js';
import { type Database, openDatabase } from '../db/database.js';

export const DAY = 24 * 60 * 60 * 1000;
export const START = Date.parse('2026-01-01T12:00:00.000Z');

export interface Harness {
  app: Application;
  db: Database;
  config: Config;
  services: Services;
  now: () => number;
  advance: (ms: number) => void;
}

/** A fully wired app on an in-memory database with a clock the test controls. */
export function createHarness(env: Record<string, string> = {}): Harness {
  let now = START;
  const config = loadConfig({
    DATABASE_PATH: ':memory:',
    RATE_LIMIT_API: '100000',
    RATE_LIMIT_SECRETS: '100000',
    ...env,
  });
  const db = openDatabase(':memory:');
  const services = createServices(db, config.retention, () => now);
  return {
    app: createApp(config, services),
    db,
    config,
    services,
    now: () => now,
    advance: (ms): void => {
      now += ms;
    },
  };
}

export const bearer = (token: string): string => `Bearer ${token}`;

export interface Owner {
  ownerId: string;
  ownerSecret: string;
  deviceId: string;
  deviceToken: string;
}

export async function createOwner(app: Application): Promise<Owner> {
  const ownerId = randomUUID();
  const ownerSecret = randomBytes(32).toString('hex');
  await request(app).post('/api/v1/owners').send({ ownerId, ownerSecret }).expect(201);
  const deviceId = randomUUID();
  const res = await request(app)
    .post(`/api/v1/owners/${ownerId}/devices`)
    .send({ ownerSecret, deviceId, name: 'Test phone' })
    .expect(201);
  return { ownerId, ownerSecret, deviceId, deviceToken: res.body.deviceToken as string };
}

export async function createShare(
  app: Application,
  owner: Owner,
  meta = 'v1.bWV0YQ',
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/shares')
    .set('Authorization', bearer(owner.deviceToken))
    .send({ meta })
    .expect(201);
  return res.body.shareId as string;
}

export async function createInvite(
  app: Application,
  owner: Owner,
  shareId: string,
): Promise<string> {
  const res = await request(app)
    .post(`/api/v1/shares/${shareId}/invites`)
    .set('Authorization', bearer(owner.deviceToken))
    .expect(201);
  return res.body.code as string;
}

export interface Reader {
  readerId: string;
  readerToken: string;
}

export async function addReader(
  app: Application,
  owner: Owner,
  shareId: string,
  displayName = 'Anna',
): Promise<Reader> {
  const code = await createInvite(app, owner, shareId);
  const res = await request(app)
    .post(`/api/v1/invites/${code}/redeem`)
    .send({ displayName })
    .expect(201);
  return { readerId: res.body.readerId as string, readerToken: res.body.readerToken as string };
}

export function entry(
  date: string,
  data: string,
  updatedAt: string,
  deviceId: string,
): { date: string; data: string; updatedAt: string; deviceId: string } {
  return { date, data, updatedAt, deviceId };
}
