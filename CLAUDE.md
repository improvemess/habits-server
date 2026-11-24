# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                         # Run with tsx (no build needed)
npm run build                       # Compile TypeScript to dist/
npx vitest run                      # All tests
npx vitest run src/routes/shares    # Single file
npm test                            # build + tests with coverage (80% threshold)
npm run lint                        # ESLint + Prettier + tsc --noEmit + knip + markdownlint
```

The package is **ESM-only**: relative imports need explicit `.js` extensions. It needs Node ≥ 22.13 for `node:sqlite`.

## Architecture

- [src/app.ts](src/app.ts): `createApp(config, services)` wires everything; `createRouters()` lists all routers with their mount prefix. The whole app is mounted below `config.basePath`.
- [src/schemas.ts](src/schemas.ts): zod schemas are the **single source of truth**. Routes validate with them (`parse()` from [src/validation.ts](src/validation.ts)) and the OpenAPI spec is generated from them.
- Every route module exports `openApiPaths` (built with `operation()` from [src/openapi/operation.ts](src/openapi/operation.ts)) next to its `createXxxRouter()`. [src/openapi.ts](src/openapi.ts) merges them. [src/openapi.test.ts](src/openapi.test.ts) is a contract test: every registered route must be documented and vice versa, and the spec must be valid OpenAPI 3.1. **When you add a route, add its `operation()` too.**
- [src/services/](src/services/): business logic on SQLite (`OwnerService`, `ShareService`, `runCleanup`). The services take a `Clock`, so tests can move time.
- [src/db/migrations.ts](src/db/migrations.ts): versioned migrations (`PRAGMA user_version`). Never edit a released migration; append a new one.

### Auth

- No accounts and no JWT. Tokens are opaque (`dt_…` device, `rt_…` reader) and stored as SHA-256 hashes only, as are `ownerSecret` and invite codes.
- `authenticate(owners, ...kinds)` in [src/middleware/auth.ts](src/middleware/auth.ts) resolves the token and allows only the listed kinds. Reader tokens are strictly read-only: a reader token on any write endpoint gets `403`.
- Shares of other owners answer `404`, not `403`, so ids do not leak.
- Endpoints that check secrets use `secretLimit`, which counts only failed attempts.

### End-to-end encryption

The server never sees the share key and never decrypts anything. `meta` and entry `data` are opaque base64url strings. Only ids, `date`, `updatedAt` and server timestamps are plain text. Never add features that would need the content.

### Sync semantics

- Every change to a share (meta, entries, end) increments `shares.revision`. `GET /shares/{id}?since=<revision>` returns entries with a higher revision.
- Entries: last writer wins per `(share, date)` by client `updatedAt`, ties broken by the higher `deviceId`; future timestamps are clamped to server time.

## Conventions

The ESLint rules match com_oliverlorenz_api: explicit return types, explicit member accessibility, no `any`, no non-null assertions outside tests, strict boolean expressions, kebab-case file names. Tests live next to the code (`*.test.ts`) and use `createHarness()` from [src/\_\_tests\_\_/harness.ts](src/__tests__/harness.ts) (in-memory DB, controllable clock).

## Release

PR titles follow Conventional Commits and drive semantic-release on `main` (`feat` = minor, `fix`/`perf` = patch, `!` = major). A release builds and pushes `ghcr.io/oliverlorenz/uhabits-server`. Never bump versions by hand.
