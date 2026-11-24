# uhabits-server

Server for sharing habits with friends in [Loop Habit Tracker](https://github.com/oliverlorenz/uhabits) (uhabits).

The owner shares single habits; only the owner checks them off, friends can only read them. The server is small and runs as one instance with SQLite for a private circle. It has no accounts and no e-mail addresses.

- **End-to-end encrypted:** the share key travels only in the fragment of the invite link. The server stores ciphertext plus the ids, dates and timestamps it needs to sync and clean up.
- **Tokens instead of accounts:** an owner identity (`ownerId` + `ownerSecret`) gets one device token per device, and each friend gets a read-only reader token from a one-time invite. The server stores every secret and token as a hash only.
- **Several servers:** anyone can run a server, and friends may be on different ones. The app checks a server via `GET /.well-known/uhabits-server`.
- **Cleans up after itself:** a daily job applies configurable retention periods (see below).

The API is documented with OpenAPI 3.1: interactive at `/docs`, raw at `/openapi.json`.

## Flow

1. The app creates the owner (`POST /api/v1/owners`) and registers the device (`POST /api/v1/owners/{ownerId}/devices`), which returns a device token.
2. It creates a share (`POST /api/v1/shares`) and uploads entries (`PUT /api/v1/shares/{shareId}/entries`; last writer wins per day by `updatedAt`).
3. It creates an invite (`POST /api/v1/shares/{shareId}/invites`) and sends the friend `https://<server-base>/invite/<code>#k=<share-key>&v=1`.
4. The friend's app redeems the invite (`POST /api/v1/invites/{code}/redeem`) and receives a reader token.
5. It reads incrementally with `GET /api/v1/shares/{shareId}?since=<revision>`.

Opened in a browser, `/invite/<code>` shows a landing page with no share content. The page offers an "open in app" link on the custom scheme `uhabits://invite?server=…&code=…&k=…&v=1`.

## Self-hosting

The image is published as `ghcr.io/oliverlorenz/uhabits-server` (tags: `latest`, `X.Y.Z`, `X.Y`).

```yaml
# docker-compose.yml
services:
  uhabits-server:
    image: ghcr.io/oliverlorenz/uhabits-server:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      TRUST_PROXY: "1"
      # PUBLIC_URL: https://habits.example.com
    volumes:
      - ./data:/data
```

Put it behind a reverse proxy that terminates **HTTPS**, because the app only talks to `https` servers. With one proxy in front, set `TRUST_PROXY=1` so that rate limits see the real client IP and invite links use `https`. Back up the `/data` volume: it holds the SQLite database.

To serve the server below a path (e.g. `https://example.com/habits`), set `BASE_PATH=/habits`. Every route then moves below that path, including `/.well-known/uhabits-server`, `/docs` and `/invite/…`. In the app, enter the full base URL `https://example.com/habits`.

## Configuration

All settings are environment variables; see [.env.example](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `BASE_PATH` | *(empty)* | Mount everything under a sub-path, e.g. `/habits` |
| `PUBLIC_URL` | *(empty)* | Public base URL for invite links; empty = taken from the request |
| `TRUST_PROXY` | `false` | Express `trust proxy` (`true`, `false`, hop count or subnet list) |
| `DATABASE_PATH` | `./data/uhabits.db` (`/data/uhabits.db` in Docker) | SQLite file |
| `APP_DOWNLOAD_URL` | GitHub releases of uhabits | Link shown on the invite landing page |
| `RATE_LIMIT_API` | `600` | Requests per 15 minutes and IP for `/api` |
| `RATE_LIMIT_SECRETS` | `20` | **Failed** attempts per 15 minutes and IP on endpoints that check secrets |
| `CLEANUP_INTERVAL_HOURS` | `24` | How often the cleanup job runs (also once at start) |

### Retention

The cleanup job decides by timestamps only, never by content.

| Case | Rule | Variable (days) |
| --- | --- | --- |
| Share ended (or habit deleted) | Content deleted at once; tombstone (id, end date) deleted after **30 days** | `TOMBSTONE_RETENTION_DAYS=30` |
| No heartbeat from any owner device | Status `inactive` after **90 days**, share ended after **12 months** | `SHARE_INACTIVE_AFTER_DAYS=90`, `SHARE_DELETE_AFTER_DAYS=365` |
| Reader token not used | Deleted after **6 months** | `READER_RETENTION_DAYS=180` |
| Invite not redeemed | Invalid and deleted after **7 days** | `INVITE_TTL_DAYS=7` |
| Device token not used | Deleted after **12 months**; the owner stays while any device is active | `DEVICE_RETENTION_DAYS=365` |
| Owner without devices and shares | Deleted (after a grace day) | — |

A share whose owner disappears becomes a tombstone first, so friends see "ended" for another 30 days before it goes.

## Development

Requires Node 22.13 or newer (the server uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env
npm run dev          # tsx, no build needed
npm test             # build + vitest with coverage
npm run lint         # eslint, prettier, tsc, knip, markdownlint
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.
