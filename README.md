# ShipShow!

> Part show, part shitshow.

Organization-wide BitBucket contribution statistics. (Codename and package name: `bbstat`.)

A dashboard-style web application for reviewing developer contributions across an entire BitBucket organization. Commit and branch activity, code-change volume, filters by project / repo / user, graphs, periodic rollups, and activity logs — all served from our own ingested store, never proxied through the BitBucket API on the request path.

## Tech stack

| Layer                  | Choice                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Frontend               | Vue 3, Vite 6, Pinia (offline-first cache), vue-router, Tailwind 4                                                |
| Backend                | Node.js 22, Fastify 5, TypeScript (strict)                                                                        |
| Database               | PostgreSQL 17 (system of record), Drizzle ORM                                                                     |
| Server-side cache      | Redis 7 — _scoped to user-summary rollups only_                                                                   |
| Background sync        | node-cron + shared `runSync()` for manual / cron / webhook triggers (see [docs/sync.md](docs/sync.md))            |
| Admin endpoints        | `/api/admin/*` for sync triggers + curated-repo management (see [docs/admin.md](docs/admin.md))                   |
| MCP server             | Read-only `@modelcontextprotocol/sdk` server for LLM agents over streamable-HTTP (see [docs/mcp.md](docs/mcp.md)) |
| Leaderboard / scoring  | Per-developer ShipShow Score, badges, persona tiers — see [docs/scoring.md](docs/scoring.md)                      |
| Reverse proxy / TLS    | Traefik 3 in dev (`compose.override.yaml`), deployer's proxy in prod; self-signed CA for local dev                |
| Container runtime      | Docker CE — full stack via `compose.yaml` + `compose.override.yaml` (multi-stage, distroless backend)             |
| Tests / lint / format  | Vitest, ESLint flat config, Prettier                                                                              |
| Package mgr / monorepo | pnpm workspaces                                                                                                   |

## Repository layout

```
bbstat/
├── apps/
│   ├── backend/                # Fastify API + sync runner + MCP server + Dockerfile (distroless)
│   └── frontend/               # Vue 3 SPA + Dockerfile (nginx) + nginx.conf
├── etc/
│   ├── tls/                    # Local self-signed CA + server cert (gitignored)
│   └── traefik/                # Traefik dynamic TLS config
├── compose.yaml                # Production base — migrate/backend/sync/mcp/frontend
├── compose.override.yaml       # Dev overlay — adds postgres, redis, traefik
├── eslint.config.js            # Flat config, applies to all workspaces
├── tsconfig.base.json          # Shared strict TS settings
└── pnpm-workspace.yaml         # Workspaces, build allowlist, dep overrides
```

## Prerequisites

- **Node.js 22** (`.nvmrc` pins it; `nvm use` if you have nvm)
- **pnpm** — installed automatically the first time you run `corepack enable` (Node 22 ships corepack)
- **Docker** — for Postgres + Redis
- **`/etc/hosts`** entry: `127.0.0.1 bbstat.localhost`
- **Local CA trust** — see TLS section below

## Quick start

```bash
corepack enable                                   # one-time, enables pnpm
make install                                      # install all workspaces
cp .env.example .env                              # fill in BitBucket creds when ready
cp tracked-repos.yaml.example tracked-repos.yaml  # curated seed list (gitignored)
```

Then pick a run mode from the table below.

## Run modes

Five ways to run the stack — local without containers (HTTP or HTTPS), full local Docker (with Traefik), or production-base Docker (with or without an external Traefik). Use this table to pick the one that matches what you're working on.

| #   | Mode                                 | When to reach for it                                                          | Prerequisites                                                                                                                                                                        | Commands                                                                                                                                  | URL                                                                                                                                                                             |
| --- | ------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Local HTTP** (host pnpm)           | Quick API iteration without cert hassle; debugging mixed-content edge cases   | In `.env`: `BACKEND_TLS=off`, `FRONTEND_TLS=off`, `VITE_API_BASE_URL=http://bbstat.localhost:8443`. Browsers refuse to mix HTTP+HTTPS — both servers must flip together.             | `make up-deps` (pg + redis) <br/> `make dev` <br/> `make dev-sync` (separate terminal — needs BB creds in `.env`)                         | `http://bbstat.localhost:5173`                                                                                                                                                  |
| 2   | **Local HTTPS** (host pnpm, default) | Day-to-day iterative work — HMR, instant restarts                             | `etc/tls/server.{crt,key}` generated; `etc/tls/ca.crt` trusted in your OS/browser store                                                                                              | `make up-deps` <br/> `make dev` <br/> `make dev-sync` (separate terminal — needs BB creds in `.env`)                                      | `https://bbstat.localhost:5173`                                                                                                                                                 |
| 3   | **Local Docker + Traefik HTTPS**     | Validating the containerized wire format — nginx config, same-origin `/api/*` | `etc/tls/` populated; `.env.docker` (auto-created from `.env.docker.example` on first `make up`) with BitBucket creds                                                                | `make up` <br/>(brings up pg + redis + traefik + migrate + backend + sync + frontend — sync runs inside the stack)                        | `https://bbstat.localhost:18443` <br/>(`TRAEFIK_HTTPS_HOST_PORT` — defaults to 18443 to avoid colliding with other local Traefik stacks; flip to `443` in `.env` for bare URLs) |
| 4   | **Prod base + external Traefik**     | Dry-running the production wire format with managed pg + redis                | `DATABASE_URL` + `REDIS_URL` exported in shell pointing at your external pg/redis; a Traefik you operate elsewhere configured to upstream to the frontend container's published port | `docker compose -f compose.yaml up -d` <br/>(NO override file — opt-out of dev pg/redis/traefik; sync container is still in compose.yaml) | Whatever your reverse proxy exposes                                                                                                                                             |
| 5   | **Prod base, no Traefik (HTTP)**     | Quick HTTP smoke against the production-base stack with no TLS layer          | Same as #4 minus the proxy                                                                                                                                                           | `docker compose -f compose.yaml up -d` <br/>Hit the frontend container's published port directly                                          | `http://localhost:${FRONTEND_HOST_PORT:-8080}`                                                                                                                                  |

**Notes**

- Mode 3 is what `make up` runs — `compose.override.yaml` is auto-loaded alongside `compose.yaml` (compose convention). Modes 4 and 5 opt out of the override via the explicit `-f compose.yaml` flag.
- Modes 4 + 5 need `DATABASE_URL` and `REDIS_URL` set in the shell, since `compose.yaml` declares them with `${VAR:?msg}` (fails fast if missing).
- The backend always listens on plain HTTP inside containers (`BACKEND_TLS=off` baked into the image); modes 4 and 5 rely on the external proxy (or none) for the public TLS layer, never the backend.
- The frontend image bakes `VITE_API_BASE_URL=""` at build time, so the SPA always requests same-origin `/api/*`. Modes 4 + 5 inherit that; whatever proxy fronts the frontend container must forward `/api/*` paths to the same upstream (nginx-in-container already does this internally — see `apps/frontend/nginx.conf`).
- **Sync runner**: `make dev` only spawns backend + frontend, so modes 1 + 2 need `make dev-sync` in a second terminal to ingest from BitBucket. Modes 3-5 include the sync runner as a compose service (`sync:` in `compose.yaml`) — it boots automatically alongside the rest. The sync runner skips with a warning if `BITBUCKET_AUTH_*` aren't set, so it's safe to leave out in modes you're just smoke-testing.

## Production deploys (image-only)

`compose.yaml` declares **no `build:` blocks** (those live in `compose.override.yaml`), so a production server with no repo checkout can boot the stack as long as the tagged images are loaded locally. **Secrets — BitBucket auth, DB / Redis URLs, image tags — are interpolated from the shell env, never persisted to disk.** Only the non-sensitive `.env.docker` (workspace, sync schedules, tuning knobs) lives on the host.

```bash
# 1. Build + tag with a real version (on the build machine, with the repo)
BACKEND_IMAGE=bbstat-backend:v1.5.1 FRONTEND_IMAGE=bbstat-frontend:v1.5.1 make build-images

# 2. Save to portable tarballs
docker save -o bbstat-v1.5.1.tar bbstat-backend:v1.5.1 bbstat-frontend:v1.5.1

# 3. Transfer images + compose.yaml + .env.docker (no secrets in it) to prod.
#    compose.override.yaml is deliberately NOT shipped.
scp bbstat-v1.5.1.tar compose.yaml .env.docker prod:/opt/bbstat/

# 4. On the production host: load images
docker load -i bbstat-v1.5.1.tar

# 5. Write a one-shot deploy.env with the secrets, source it, delete it.
cat > deploy.env <<'EOF'
export BACKEND_IMAGE=bbstat-backend:v1.5.1
export FRONTEND_IMAGE=bbstat-frontend:v1.5.1
export DATABASE_URL=postgres://user:PASS@db-host:5432/bbstat
export REDIS_URL=redis://redis-host:6379
export BITBUCKET_AUTH_EMAIL=you@example.com
export BITBUCKET_AUTH_TOKEN=ATATT3xFf…
EOF
source deploy.env && rm -f deploy.env

# 6. Boot — compose.yaml interpolates the env vars at parse time.
docker compose -f compose.yaml up -d
```

Rollback is the same flow with the previous tag — both versions can sit on the host simultaneously, swap by re-exporting `BACKEND_IMAGE` / `FRONTEND_IMAGE` and `compose up -d` again.

**Variables that come from the shell env** (not `.env.docker`): `BACKEND_IMAGE`, `FRONTEND_IMAGE`, `DATABASE_URL`, `REDIS_URL`, `BITBUCKET_AUTH_EMAIL`, `BITBUCKET_AUTH_TOKEN`. The first two have `:-latest` defaults; the rest are either hard-required (`:?`) or empty-by-default (sync disables silently if BB creds are absent).

## Backups

A daily **data-only** Postgres backup script — [`bbstat-backup.sh`](bbstat-backup.sh) — ships alongside `compose.yaml`. It runs `pg_dump` **inside** the Postgres container (hitting Postgres directly, past any reverse proxy / pooler, with a version-matched dump), writes a compressed custom-format dump, verifies it (`pg_restore --list`), and keeps the newest 7 (`RETENTION`). **Data-only on purpose:** the schema is owned by the migrations (the `migrate` one-shot), never the dump — so a restore goes into a freshly-migrated, _empty_ database.

Deploy + schedule on the host, as a user in the `docker` group (not root):

```bash
scp bbstat-backup.sh prod:/opt/bbstat/ && ssh prod 'chmod +x /opt/bbstat/bbstat-backup.sh'
# daily 05:00 — point BACKUP_DIR + the log at paths the cron user can write:
crontab -e
0 5 * * * BACKUP_DIR=/home/deploy/bbstat-backups /opt/bbstat/bbstat-backup.sh >> /home/deploy/bbstat-backup.log 2>&1
```

Config via env (script defaults shown): `BACKUP_DIR` (`/var/backups/bbstat`), `RETENTION` (`7`), `PG_CONTAINER` (`bbstat-pg`). **Permissions caveat:** a non-root cron user can't write to `/var/log` or `/var/backups`, so either override `BACKUP_DIR` and the log to paths it owns (as above), or pre-create those dirs/files `chown`ed to that user — otherwise the cron redirect fails before the script even runs. The script writes atomically (verifies a `.partial`, then renames), refuses to write into its own directory, and skips overlapping runs (`flock`). Failures go to stderr (set `MAILTO` in cron to be alerted); it's quiet on success.

Restore (also in the script header) — into a migrated, empty target DB:

```bash
docker exec -i bbstat-pg pg_restore -U bbstat -d <db> \
  --data-only --no-owner --no-privileges --disable-triggers < bbstat-data-<ts>.dump
```

(`--disable-triggers` needs superuser; drop it and rely on `pg_restore`'s dependency ordering if the `bbstat` role isn't a superuser.)

## Common commands

The root `Makefile` is the canonical entry point for everyday workflows. `make help` lists every target. Most common:

```bash
# Container stack (compose.yaml + compose.override.yaml)
make up              # full stack: pg + redis + traefik + backend + sync + frontend
make up-deps         # just pg + redis (for the host hot-reload workflow)
make down            # stop (keeps volumes)
make reset           # stop AND drop volumes
make ps              # service status
make logs            # tail all service logs (use logs-backend / logs-frontend / etc. for per-service)
make build-images    # docker compose build backend frontend
make stack-migrate   # one-shot Drizzle migrator against the stack's postgres
make stack-rebuild   # rebuild images + rolling-restart

# Host hot-reload (Vite HMR + tsx watch)
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

On a fresh checkout (one-time per developer), generate the CA + server cert and trust the CA in your OS and browser. The full cookbook — OpenSSL commands using `etc/tls/server.san`, Linux trust-store steps for Fedora / Debian / Arch, the Chrome-on-Linux NSS `certutil` flow, and the rotation playbook — lives in [`etc/tls/README.md`](etc/tls/README.md).

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

## Documentation

The [`docs/`](docs/README.md) folder is the canonical home for narrative documentation. Start at [`docs/README.md`](docs/README.md) for the full index; the table below is the quick-jump.

| Doc                                                | Covers                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)               | Phased plan — what's landed, what's deferred, what's next.                                                                                        |
| [`docs/sync.md`](docs/sync.md)                     | Backpressure algorithm, the five sync queues, commit / PR / diff-stats / deepen / is-merge ticks, `/api/activity`, live updates, tuning playbook. |
| [`docs/scoring.md`](docs/scoring.md)               | ShipShow Score — per-commit math, decay, consistency, badge cascade, Steady Eddie tiers, member persona categorization.                           |
| [`docs/members.md`](docs/members.md)               | `/members` page surface — eligibility, sort / search / pagination, donut + Lorenz charts, SSE, email capture. Doubles as the leaderboard.         |
| [`docs/people.md`](docs/people.md)                 | Phase 5 person layer (alias merge) — schema + leaderboard view, person-aware rollup, `/api/admin/people` endpoints + curl recipes, `/people/:id`. |
| [`docs/admin.md`](docs/admin.md)                   | Every `/api/admin/*` endpoint — sync triggers, curated-set management, archive / rename / include, score recompute. With curl examples.           |
| [`docs/frontend-cache.md`](docs/frontend-cache.md) | The `CACHE_VERSION` mechanism that wipes stale Pinia `localStorage` on shape changes; when to bump, side effects, multi-tab edge case.            |
| [`etc/tls/README.md`](etc/tls/README.md)           | Local TLS cookbook — OpenSSL commands, Linux system-trust steps, Chrome NSS `certutil` flow, rotation playbook.                                   |
| [`CLAUDE.md`](CLAUDE.md)                           | Architecture rules — Postgres / Redis / Pinia layering, auth posture, persisted-store-shape bump checklist, container-stack mechanics.            |

## Releases

Full notes in [`CHANGELOG.md`](CHANGELOG.md). Untagged work-in-progress lives on `main` between releases.

| Version | Date       | Headline                                                                                                                                                                                                            |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.5.1   | 2026-06-13 | Frontend UX — icon breadcrumbs replace the static back-link (home › section › `[id]`; Activity page retitled **Commits**); empty repos now listed in the Repositories **Issues** tab                                |
| 1.5.0   | 2026-06-09 | Read-only **MCP server** for LLM agents — 11 tools over the dashboard read API (streamable-HTTP, bearer-gated), shipped as a new `mcp` role on the backend image + compose service (see [docs/mcp.md](docs/mcp.md)) |
| 1.4.1   | 2026-06-09 | Hotfix — cold (never-synced) repos from a discovery sweep no longer starve the active sync rotation; warm repos served first, cold first-syncs capped per tick (`SYNC_MAX_COLD_REPOS_PER_TICK`)                     |
| 1.4.0   | 2026-06-09 | Workspace-repo auto-discovery (track the workspace by `updated_on`, off by default); repo detail + project pages get the benign Empty / Archived treatment; Archived filter tab on the index                        |
| 1.3.0   | 2026-06-09 | Sync-recovery tooling — surgical `/reconcile` for history-rewritten repos, empty-repo revival sweep; Repositories page distinguishes benign Archived / Empty states from real issues                                |
| 1.2.0   | 2026-05-25 | Person layer goes end-to-end — Top Contributors, repo / project / activity surfaces all person-aware; multi-actor activity; Linked accounts                                                                         |
| 1.1.0   | 2026-05-24 | ShipShow Score leaderboard, member persona tiers (active / dormant / ex-member), BB token-expiry surface, merge-exclusion rollup fix                                                                                |
| 1.0.0   | 2026-05-21 | First tagged release — BitBucket ingest pipeline, rollups + dashboard, Projects / Repositories / Members / Activity pages, containerized deploy                                                                     |

## Agents

This repo is developed with [Claude Code](https://claude.com/claude-code). AI-authored changes follow the same standards as human-authored ones — same lint, same tests, same review.

## License

Copyright (c) 2026, Tiger IT Bangladesh Limited. All rights reserved.
