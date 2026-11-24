/**
 * Versioned schema migrations. Entry `i` migrates the schema from version `i`
 * to `i + 1`; the current version lives in `PRAGMA user_version`.
 *
 * Never change a migration that has been released — append a new one instead.
 * All timestamps are milliseconds since the epoch (UTC).
 */
export const migrations: readonly string[] = [
  `
  CREATE TABLE owners (
    id           TEXT PRIMARY KEY,
    secret_hash  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    -- last time any device of this owner talked to the server
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    id           TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    name         TEXT,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  CREATE INDEX devices_last_seen ON devices(last_seen_at);

  CREATE TABLE shares (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    -- encrypted master data; NULL once the share has ended (tombstone)
    meta       TEXT,
    -- incremented on every change, used as the "since" cursor
    revision   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at   INTEGER
  );
  CREATE INDEX shares_owner ON shares(owner_id);
  CREATE INDEX shares_ended ON shares(ended_at);

  CREATE TABLE entries (
    share_id   TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    data       TEXT NOT NULL,
    -- client timestamp for last-writer-wins
    updated_at INTEGER NOT NULL,
    device_id  TEXT NOT NULL,
    -- share revision at which this entry last changed
    revision   INTEGER NOT NULL,
    PRIMARY KEY (share_id, date)
  );
  CREATE INDEX entries_revision ON entries(share_id, revision);

  CREATE TABLE invites (
    code_hash   TEXT PRIMARY KEY,
    share_id    TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    redeemed_at INTEGER
  );
  CREATE INDEX invites_expires ON invites(expires_at);

  CREATE TABLE readers (
    id           TEXT PRIMARY KEY,
    share_id     TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX readers_share ON readers(share_id);
  CREATE INDEX readers_last_seen ON readers(last_seen_at);
  `,
];
