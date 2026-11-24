import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.js';

export type Database = DatabaseSync;

/**
 * Opens (and creates, if needed) the SQLite database and brings its schema up
 * to date. Pass `':memory:'` for a throw-away database in tests.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function schemaVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

function migrate(db: Database): void {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this server (${migrations.length})`,
    );
  }
  for (let version = current; version < migrations.length; version++) {
    transaction(db, () => {
      db.exec(migrations[version] ?? '');
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

/** Runs `fn` inside a transaction; rolls back if it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
