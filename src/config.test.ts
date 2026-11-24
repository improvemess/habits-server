import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

describe('loadConfig', () => {
  it('uses the confirmed default retention periods', () => {
    const config = loadConfig({});
    expect(config.retention).toEqual({
      inviteTtl: 7 * DAY,
      tombstone: 30 * DAY,
      shareInactiveAfter: 90 * DAY,
      shareDeleteAfter: 365 * DAY,
      reader: 180 * DAY,
      device: 365 * DAY,
    });
    expect(config.cleanupInterval).toBe(DAY);
    expect(config.basePath).toBe('');
    expect(config.trustProxy).toBe(false);
  });

  it('reads overrides', () => {
    const config = loadConfig({
      PORT: '8080',
      BASE_PATH: '/habits/',
      PUBLIC_URL: 'https://example.com/habits/',
      TOOMBSTONE: 'ignored',
      READER_RETENTION_DAYS: '10',
      CLEANUP_INTERVAL_HOURS: '1',
    });
    expect(config.port).toBe(8080);
    expect(config.basePath).toBe('/habits');
    expect(config.publicUrl).toBe('https://example.com/habits');
    expect(config.retention.reader).toBe(10 * DAY);
    expect(config.cleanupInterval).toBe(60 * 60 * 1000);
  });

  it.each([
    ['true', true],
    ['2', 2],
    ['loopback', 'loopback'],
    ['', false],
  ])('parses TRUST_PROXY=%s', (value, expected) => {
    expect(loadConfig({ TRUST_PROXY: value }).trustProxy).toBe(expected);
  });

  it.each([
    { BASE_PATH: 'habits' },
    { PUBLIC_URL: 'not a url' },
    { READER_RETENTION_DAYS: '0' },
    { PORT: 'abc' },
  ])('rejects %j', (env) => {
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
  });
});
