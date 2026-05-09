# ShipShow!

> Part show, part shitshow.

Organization-wide BitBucket contribution statistics. (Codename and package name: `bbstat`.)

A dashboard-style web application for reviewing developer contributions across an entire BitBucket organization. Commit and branch activity, code-change volume, filters by project / repo / user, graphs, periodic rollups, and activity logs — all served from our own ingested store, never proxied through the BitBucket API on the request path.

## Tech stack

| Layer                  | Choice                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| Frontend               | Vue 3, Vite 6, Pinia (offline-first cache), vue-router, Tailwind 4                                     |
| Backend                | Node.js 22, Fastify 5, TypeScript (strict)                                                             |
| Database               | PostgreSQL 17 (system of record), Drizzle ORM                                                          |
| Server-side cache      | Redis 7 — _scoped to user-summary rollups only_                                                        |
| Background sync        | node-cron + shared `runSync()` for manual / cron / webhook triggers (see [docs/sync.md](docs/sync.md)) |
| Reverse proxy / TLS    | Traefik (planned), self-signed CA for local dev (`etc/tls/`)                                           |
| Container runtime      | Docker CE (Postgres + Redis via `docker-compose.yml`)                                                  |
| Tests / lint / format  | Vitest, ESLint flat config, Prettier                                                                   |
| Package mgr / monorepo | pnpm workspaces                                                                                        |

## Repository layout

```
bbstat/
├── apps/
│   ├── backend/        # Fastify HTTPS API + sync runner
│   └── frontend/       # Vue 3 SPA
├── etc/tls/            # Local self-signed CA + server cert (gitignored)
├── docker-compose.yml  # postgres + redis for local dev
├── eslint.config.js    # Flat config, applies to all workspaces
├── tsconfig.base.json  # Shared strict TS settings
└── pnpm-workspace.yaml # Workspaces, build allowlist, dep overrides
```

## Prerequisites

- **Node.js 22** (`.nvmrc` pins it; `nvm use` if you have nvm)
- **pnpm** — installed automatically the first time you run `corepack enable` (Node 22 ships corepack)
- **Docker** — for Postgres + Redis
- **`/etc/hosts`** entry: `127.0.0.1 bbstat.localhost`
- **Local CA trust** — see TLS section below

## Quick start

```bash
corepack enable                              # one-time, enables pnpm
make install                                 # install all workspaces
cp .env.example .env                         # fill in BitBucket creds when ready
make up                                      # start postgres + redis
make dev                                     # backend on :8443, frontend on :5173 (both HTTPS)
```

Open `https://bbstat.localhost:5173`.

## Common commands

The root `Makefile` is the canonical entry point for everyday workflows. `make help` lists every target. Most common:

```bash
# Docker dependencies
make up              # start postgres + redis
make down            # stop (keeps volumes)
make reset           # stop AND drop volumes
make ps              # service status
make logs            # tail all service logs

# Dev servers
make dev             # both apps in parallel
make dev-backend     # backend only (https://bbstat.localhost:8443)
make dev-frontend    # frontend only (https://bbstat.localhost:5173)
make dev-sync        # background sync runner

# Tests
make test            # all tests
make test-backend    # backend only
make test-frontend   # frontend only
make test-watch      # watch mode, both apps

# Quality gates
make typecheck
make lint
make format
make format-check
make check           # typecheck + lint + format-check + test (CI-equivalent)

# Build
make build           # production builds for both apps
make build-backend
make build-frontend

# Drizzle migrations
make db-generate     # generate SQL from schema diff
make db-migrate      # apply pending migrations
make db-studio       # open Drizzle Studio
```

Underneath, every target wraps a `pnpm` invocation — drop down to `pnpm` directly for things the Makefile doesn't expose:

```bash
# Single test file
pnpm --filter @bbstat/backend exec vitest run tests/health.test.ts
pnpm --filter @bbstat/frontend exec vitest run tests/StatCard.test.ts
```

## Local TLS

Both dev servers terminate HTTPS directly using the self-signed material under `etc/tls/`. Those files are **gitignored** — they are per-developer fixtures, not committed material.

To generate them on a fresh checkout (one-time per developer), use the SAN config at `etc/tls/server.san` with OpenSSL to produce:

- `ca.crt` / `ca.key` — local development CA
- `server.crt` / `server.key` — server cert signed by the CA, scoped to `bbstat.localhost`, `localhost`, `127.0.0.1`

Then **import `ca.crt` into your OS / browser trust store** so HTTPS to `bbstat.localhost` is trusted without warnings.

## Development standards

This project targets the latest stable versions of every component, and the corollary is a hard discipline on quality: **zero errors and zero warnings, anywhere.**

### Zero errors / zero warnings

Every layer of the toolchain must be clean:

| Step             | Bar                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------ |
| `pnpm install`   | No deprecated-subdep warnings, no peer-dep warnings, no ignored-build prompts        |
| `pnpm typecheck` | Zero TS errors, zero warnings (strict mode + `noUncheckedIndexedAccess`)             |
| `pnpm lint`      | Zero ESLint errors **and** zero warnings — warning-level rules count                 |
| `pnpm test`      | All tests pass, no unhandled rejections, no Node deprecation warnings during the run |
| `pnpm build`     | Clean builds, no Vite chunk-size or sourcemap warnings, no TS rebuild warnings       |
| Server console   | No unhandled rejections, no deprecation warnings, structured logs only               |
| Browser console  | No errors, no warnings during normal operation                                       |

If a warning appears, **fix the cause** — don't silence it with `--no-warnings` or rule disables. Acceptable exceptions are documented (e.g. `pnpm.overrides` in `pnpm-workspace.yaml` to force-bump deprecated transitives).

### Safe dependencies

- Pin `engines.node` and `packageManager` so the toolchain is reproducible across machines.
- Prefer the **latest stable major** of every direct dependency. Track upstream releases.
- Run `pnpm audit` regularly; address advisories rather than ignoring them.
- When a transitive dep is deprecated and unfixable from our `package.json`, use `pnpm.overrides` in `pnpm-workspace.yaml` to push it forward (see the existing `glob` override).
- Avoid abandonware: prefer libraries with active maintenance, recent releases, and a real test suite.
- Lockfile (`pnpm-lock.yaml`) is committed and authoritative — install with `pnpm install --frozen-lockfile` in CI.

### Clean consoles

- **Never use `console.log` / `console.info` / `console.debug` in committed code.** ESLint enforces this (`no-console` rule; `console.warn` and `console.error` are allowed for genuine problem reporting).
- Backend logs go through Fastify's structured logger (`app.log`) or pino (`bbstat-sync` runner). No ad-hoc prints.
- Frontend should not log during normal operation. Use a logger utility for diagnostics — and gate it on dev mode.
- Browser warnings (Vue prop type mismatches, hydration mismatches, dev-only Pinia warnings, etc.) are bugs, not noise. Fix the root cause.

### TypeScript settings

Strict mode is on across the monorepo (`tsconfig.base.json`):

- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax` — use `import type { ... }` for type-only imports (also enforced by ESLint)
- `isolatedModules` — every file must be transpilable on its own (Vite/tsx requirement)
- ESM throughout (`"type": "module"`), `moduleResolution: Bundler`

### Architectural rules

- **Backend never proxies live BitBucket calls** on the request path. BitBucket is an ingest-time dependency only; sync workers populate Postgres.
- **Redis is for user-summary rollups only.** Don't use it as a generic key-value front cache for Postgres.
- **Pinia is the client-side cache.** Frontend reads come from Pinia first; persisted across reloads via `pinia-plugin-persistedstate`.
- **No auth today, by design.** Everyone sees everything to drive intra-org transparency. BitBucket OAuth comes later — leave a seam for `userId`, but don't pre-build login flows.

See `CLAUDE.md` for the full rationale on each.

## Agents

This repo is developed with [Claude Code](https://claude.com/claude-code) and GitHub Copilot. AI-authored changes follow the same standards as human-authored ones — same lint, same tests, same review.

## License

Copyright (c) 2026, Tiger IT Bangladesh Limited. All rights reserved.
