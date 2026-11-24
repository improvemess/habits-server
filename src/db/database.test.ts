import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, schemaVersion, transaction } from './database.js';
import { migrations } from './migrations.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates the file and applies all migrations once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uhabits-server-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'test.db');
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(migrations.length);
    db.prepare("INSERT INTO owners VALUES ('o', 'h', 1, 1)").run();
    db.close();

    const reopened = openDatabase(path);
    expect(schemaVersion(reopened)).toBe(migrations.length);
    expect(reopened.prepare('SELECT id FROM owners').all()).toEqual([{ id: 'o' }]);
    reopened.close();
  });

  it('refuses a database from a newer server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uhabits-server-'));
    dirs.push(dir);
    const path = join(dir, 'test.db');
    const db = openDatabase(path);
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer than this server/);
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      db.prepare("INSERT INTO shares VALUES ('s', 'missing', 'm', 1, 1, 1, NULL)").run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('transaction', () => {
  it('rolls back when the callback throws', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO owners VALUES ('o', 'h', 1, 1)").run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM owners').get()).toEqual({ n: 0 });
  });
});
