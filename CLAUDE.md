# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**ShipShow!** (codename and package name: `bbstat`) is a dashboard-style web application for reviewing developer contributions across an entire BitBucket organization. It requires a BitBucket API account at runtime.

The "ShipShow!" name is the human-facing brand — used in the UI, README title, and the HTML `<title>`. Code-side identifiers (`bbstat`, `@bbstat/backend`, `@bbstat/frontend`, `bbstat.localhost`, `bbstat-postgres` / `bbstat-redis` containers, the `bbstat` Postgres database) are unchanged. Don't rename the package or any infrastructure identifier when working on this — they're load-bearing across env vars, scripts, and Docker.

Feature surface to design for:

- Commit and branch activity tracking, code-change volume metrics
- Filters and search across **projects**, **repositories**, and **users**
- Graphs and periodic statistics (daily/weekly/monthly rollups)
- Activity logs / event feeds per developer, repo, or project

## Architectural shape

Three layers — keep them separate; don't collapse them into a single tier.

1. **Background sync workers.** BitBucket's API is the upstream source of truth, but it is slow and rate-limited. Sync programs run out-of-band, pulling commits / branches / activity into our own store. Idempotent and resumable, because they are triggered three ways and can race:
   - **Manual** — operator-initiated re-sync (UI button or admin endpoint), e.g. backfills or after fixing a sync bug.
   - **Cron-style** — periodic scheduled pulls for steady-state freshness. Stub lives at `apps/backend/src/sync/index.ts`.
   - **Webhook-driven** — BitBucket push events for low-latency updates on hot repos.
     All three call into the same `runSync()` entrypoint at `apps/backend/src/sync/runner.ts` — dedupe / idempotency lives there, not at the caller.
2. **Backend services + Redis (scoped).** A Fastify (Node.js) backend serves the dashboard from our local **PostgreSQL** store, **never** by proxying live BitBucket calls on the request path. Treat BitBucket as an ingest-time dependency only.
   - **PostgreSQL** is the system of record. Schema source of truth: `apps/backend/src/db/schema.ts` (Drizzle ORM). Two parallel migration artifacts: (1) `apps/backend/drizzle/` — what `make db-migrate` actually applies; (2) `apps/backend/schema/` — Flyway-style `V<n>__<desc>.sql` mirror for manual / DBA-facing migrations. Both must be updated in lockstep when schema changes; see `apps/backend/schema/README.md` for the workflow.
   - **Redis** is used **only** for caching expensive **user summary rollups**. Helpers in `apps/backend/src/cache/redis.ts`. Do not use Redis as a generic key-value layer in front of every Postgres query — if a query is cheap, hit Postgres directly. Sync workers are responsible for invalidating affected user-summary entries when new data lands.
3. **Offline-first frontend with Pinia as the client cache.** Vue 3 + Vite + Pinia + Tailwind 4. **Composition API only** — `<script setup>` SFCs and Pinia setup-style stores. Options API (`data()`, `methods:`, `computed:`, lifecycle methods on the options object, etc.) is forbidden and ESLint enforces this via `vue/component-api-style`. **Pinia is the client-side cache** — persisted across reloads via `pinia-plugin-persistedstate`. The backend is the source of truth, Pinia is the read-side cache for the user's session; UI reads come from Pinia first and reconcile against the backend when online. Don't write frontend code that assumes the network is always available.

**Cache layering, in one line:** Postgres = truth, Redis = pre-computed user summaries on the server, Pinia = the browser's working copy. Don't blur these.

When in doubt about where logic belongs: aggregation/rollup work goes in the sync layer or backend, not the client.

### Changing a persisted-store shape — bump `CACHE_VERSION`

Pinia stores persist their state to `localStorage` (via `pinia-plugin-persistedstate`), and components read synchronously from that cache before the backend responds. A field that exists in the new TypeScript shape but not in the persisted blob renders `undefined`, with everything that implies. The boot-time bust handles this automatically — but only if you bump the version.

Any time you do one of the following:

- Add, rename, or remove a field on a `defineStore(...)` body that is referenced inside its `persist.pick` list
- Add or remove an entry from a `persist.pick` array
- Change the shape of a type that flows into a persisted store — most notably `WorkspaceMember`, `UserSummary`, `TrackedRepositorySummary`, `ProjectStats`, `RepoActivity`, `ActivityEntry` and their nested types (these live in `apps/frontend/src/api/client.ts`, mirrored from `apps/backend/src/dashboard/stats-store.ts`)
- Change the `pinia-plugin-persistedstate` config (serializer, key strategy, etc.)

…increment `CACHE_VERSION` in `apps/frontend/src/lib/cache-version.ts` in the **same commit / PR** as the shape change. The boot bust in `lib/cache-bust.ts` runs before any store hydrates and wipes every `bbstat-*` prefixed localStorage key when the sentinel mismatches the in-code version, so users see fresh data on their next reload — no manual `localStorage.clear()` console command, no support questions about UUIDs showing where emails should be.

**Redis is separate and stays manual.** The server-side cache (`bbstat:*` keys, today only `UserSummary` rollups via `apps/backend/src/dashboard/user-summary-cache.ts`) survives across browser sessions and across server restarts — auto-flushing on every boot would defeat the cache. When a shape change touches a Redis-cached payload, the operator runs `docker compose exec redis redis-cli FLUSHDB` after deploy. Surface this as part of the post-deploy reminder for any change involving `UserSummary` (or future Redis-cached shapes).

**Multi-tab caveat.** If a user has the app open in two tabs during the deploy, the older tab's in-memory state can write the old shape back to `localStorage` under the new key after the sentinel has already been updated. Reloading the older tab fixes it. Not common enough to engineer around — flag if it starts biting in practice and the follow-up is a `storage`-event listener that calls `location.reload()` on sentinel change.

## Authentication

**Currently: none — by design.** Everyone in the deployed environment sees everything; the explicit goal is to drive intra-org transparency and competitiveness. Do not add login flows, session middleware, or per-request auth checks unless explicitly asked.

**Planned: "Login with BitBucket"** (OAuth against BitBucket). When this lands it will replace the open access model, so:

- Don't bake assumptions about anonymous access deeply into APIs or schemas — leave a seam where a `userId` / actor identity can be plumbed through later (request context, audit columns).
- Don't pre-build the OAuth flow speculatively either; wait until it's the active task.

## Repo layout

```
bbstat/
├── apps/
│   ├── backend/                # Fastify HTTPS API + sync runner (Node.js, TS, Drizzle, Redis, Vitest)
│   │   └── Dockerfile          # Multi-stage → distroless nodejs22 runtime (backend + sync + migrate)
│   └── frontend/               # Vue 3 SPA (Vite, Pinia, vue-router, Tailwind 4, Vitest)
│       ├── Dockerfile          # Multi-stage → nginx-unprivileged runtime
│       └── nginx.conf          # SPA fallback + /api/* proxy to backend service
├── etc/
│   ├── tls/                    # Local self-signed CA + server cert (NOT committed)
│   └── traefik/                # Traefik dynamic config (TLS file provider)
├── compose.yaml                # Production base — 4 services (migrate, backend, sync, frontend)
├── compose.override.yaml       # Dev-only overlay — adds postgres, redis, traefik + dev wiring
├── eslint.config.js            # Flat config, applies to all workspaces
├── tsconfig.base.json          # Shared strict TS settings
├── pnpm-workspace.yaml         # Workspaces: apps/*, packages/*; pnpm.overrides
├── .env.example                # Host workflow env (`make dev` + `make up-deps`)
├── .env.docker.example         # Containerized stack env (loaded by compose `env_file:`)
└── tracked-repos.yaml.example  # Copy to tracked-repos.yaml — curated seed list (gitignored)
```

There is no `packages/*` yet. If shared TS types between backend and frontend become useful, that is where they'd land (e.g. `packages/shared`).

## Common commands

The root `Makefile` is the canonical entry point — prefer `make <target>` when one fits. Run `make help` to list everything. Common ones:

```bash
make install                 # pnpm install (all workspaces)

# Containerized stack — full image-built parity with prod (compose.yaml + override).
make up                      # Full stack: pg + redis + traefik + migrate + backend + sync + frontend
make up-deps                 # Just pg + redis (for the `make dev` host workflow)
make down                    # Stop everything (volumes preserved)
make reset                   # Stop AND drop volumes (wipes pg + redis data)
make ps          / make logs # Service status / tail logs across the stack
make logs-pg / -redis / -backend / -frontend / -sync / -traefik
make build-images            # docker compose build backend frontend
make stack-migrate           # Re-run the one-shot Drizzle migrator against the stack pg
make stack-rebuild           # `compose up -d --build` — rebuild + rolling-restart

# Host hot-reload workflow — backend via tsx, frontend via Vite, both on the host.
make dev                     # backend + frontend in parallel (HTTPS, host pnpm)
make dev-backend             # backend only (https://bbstat.localhost:8443)
make dev-frontend            # frontend only (https://bbstat.localhost:5173)
make dev-sync                # background sync runner (cron-mode stub)

make test                    # all tests (both apps)
make test-backend            # backend tests only
make test-frontend           # frontend tests only
make test-watch              # watch mode

make typecheck / make lint / make format / make format-check
make check                   # typecheck + lint + format-check + test (CI-equivalent)
make build  / make build-backend / make build-frontend

make db-generate             # Drizzle: generate SQL from schema.ts diff
make db-migrate              # Drizzle: apply pending migrations
make db-studio               # Drizzle Studio UI

make clean                   # rm dist/, build/, coverage/, .vite/, *.tsbuildinfo
make clean-deps              # rm node_modules and pnpm-lock.yaml
```

For things the Makefile doesn't wrap, drop to pnpm directly:

```bash
# Single test file
pnpm --filter @bbstat/backend exec vitest run tests/health.test.ts
pnpm --filter @bbstat/frontend exec vitest run tests/StatCard.test.ts
```

## Local dev prerequisites

1. **`/etc/hosts` entry** — both dev servers bind to `bbstat.localhost`. Add:
   ```
   127.0.0.1 bbstat.localhost
   ```
   (Most modern resolvers already map `*.localhost` to `127.0.0.1`, but pin it explicitly to avoid surprises.)
2. **Trust the local CA** — `etc/tls/ca.crt` must be imported into the OS / browser trust store, otherwise the dev server will throw cert warnings. Each developer does this once on their machine.
3. **Copy `.env.example` to `.env`** at the repo root. Both apps load it (backend via `node --env-file`, frontend via Vite's `loadEnv`). Fill in BitBucket credentials when ready to ingest.
4. **Copy `tracked-repos.yaml.example` to `tracked-repos.yaml`** at the repo root and edit the `repos:` list. The file is **seed-only**: each `<workspace>/<slug>` entry is auto-inserted into `repositories` on the next `runReposSync` / `runDiscoverySync` (no restart needed), and per-flag values like `diffStats` / `archived` seed the initial column values. Once a row exists, the DB is canonical — admin endpoints (`POST /repositories/:ws/:slug/archive`, `/unarchive`) or direct SQL flip the flags, and those changes survive every subsequent discovery sync. Removing a repo from YAML does **not** untrack it; use the archive endpoint. Override the location with `SEED_REPO_FILE_PATH` in `.env` (default: `tracked-repos.yaml` at the repo root; a missing default file is a no-op).
5. **Postgres + Redis** — start via `make up-deps` (just pg + redis) before running the backend with `make dev`. Or use `make up` to launch the full containerized stack instead (see below).

## Local TLS (`etc/tls/`)

Self-signed CA and server certificate for local HTTPS. **These files are gitignored** (`etc/tls` line in `.gitignore`) — they are per-developer fixtures, not committed material. If the directory is empty on a fresh clone, regenerate using OpenSSL with the `server.san` config (CN: `bbstat.localhost`, SAN: `bbstat.localhost`, `localhost`, `127.0.0.1`).

Both Vite and Fastify load these at startup:

- Backend: `apps/backend/src/index.ts` reads `TLS_KEY_PATH` / `TLS_CERT_PATH` (env-overridable, default `etc/tls/server.key` / `server.crt` relative to repo root).
- Frontend: `apps/frontend/vite.config.ts` reads the same files.

Do **not** regenerate `ca.crt` / `ca.key` casually once developers have trusted them — they'll have to re-trust the new CA. Server cert can be re-issued from the same CA without breaking trust.

## Container stack (compose) — two workflows

The project supports two coexisting development workflows. Pick based on what you're working on:

| Workflow                 | Command                     | What runs where                                                                                                                                                   | When to use                                                                                           |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Host hot-reload**      | `make up-deps` + `make dev` | pg + redis in containers; backend (`tsx watch`) + Vite dev server on the host. HMR, cross-origin to backend via CORS (`https://bbstat.localhost:5173` → `:8443`). | Default for iterative work. Edits land instantly.                                                     |
| **Containerized parity** | `make up`                   | Everything in containers behind Traefik at `https://bbstat.localhost`. nginx serves the built SPA, proxies same-origin `/api/*` to the backend service. No HMR.   | Validating the production wire format — nginx config, same-origin routing, the migrate one-shot, etc. |

### Compose file split

- **`compose.yaml`** (production base) defines 4 services: `migrate` (one-shot Drizzle migrator), `backend`, `sync`, `frontend`. No postgres, no redis, no Traefik — those are externally managed in production. `DATABASE_URL` / `REDIS_URL` are required at deploy time (`${VAR:?msg}` syntax fails fast if missing).
- **`compose.override.yaml`** (auto-loaded for dev only — production deploys pass `-f compose.yaml` to skip it) adds `postgres` + `redis` + `traefik`, rewires `DATABASE_URL` / `REDIS_URL` to those internal services, mounts `tracked-repos.yaml` into backend + sync, and attaches Traefik routing labels to the frontend.

### What changes in the container vs host

- **Backend listens on plain HTTP** (`BACKEND_TLS=off`) on port 8080. The reverse proxy (Traefik in dev, deployer's proxy in prod) is the public TLS edge. The backend image doesn't ship certs and won't start with `BACKEND_TLS=on`.
- **Frontend is built (not Vite-dev) and served by nginx**. `VITE_API_BASE_URL=""` is baked at build time so `/api/*` resolves same-origin; nginx then proxies internally to `backend:8080` over the compose network. The legacy cross-origin `:8443` route is unused in the containerized stack.
- **One image, three roles**: backend, sync, and migrate are all the same `apps/backend/Dockerfile` artifact with different `command:` overrides (`dist/index.js`, `dist/sync/index.js`, `dist/scripts/migrate.js`). Keep changes that affect all three lockstep — there's no per-role image.
- **Migrate gates the rest**: backend + sync use compose's `depends_on: service_completed_successfully` against the migrate one-shot. A failed migration prevents the dependents from ever starting.
- **`SEED_REPO_FILE_PATH` is pinned to `/app/tracked-repos.yaml`** in `compose.yaml`. The source-relative `repoRoot` calculation in `index.ts` resolves to `/` inside the flat container layout, so explicit pinning keeps the seed loader pointed somewhere sensible. The dev override bind-mounts the host file at that path.

### Env files

- **`.env`** (host workflow) — loaded by `node --env-file` and Vite's `loadEnv()`. Has `DATABASE_URL` / `REDIS_URL` pointing at the host ports (`localhost:15432`, `localhost:16379`) and all the dev-server config.
- **`.env.docker`** (containerized stack, gitignored) — loaded by compose's `env_file:` for migrate / backend / sync. Trimmed shape documented in `.env.docker.example`. Does NOT contain `DATABASE_URL` / `REDIS_URL` (compose sets those) or `VITE_*` (frontend bundle is built, runtime overrides have no effect).

### Reverse proxy: dev vs production

The dev Traefik in `compose.override.yaml` is a **dev fixture** — it mirrors the production wire format (TLS termination upstream, plain HTTP to the frontend container, frontend proxies `/api/*` to backend internally) so you catch nginx/Traefik config bugs locally. **In production, the deployer's existing reverse proxy plays Traefik's role** — `compose.yaml` ships no proxy, only publishes the frontend container's port.

If a change touches the public wire format (nginx config, frontend's `/api` proxy_pass, Traefik labels), validate with `make up` (containerized parity) before merging — `make dev` doesn't go through nginx and can mask the bug.

## Quality bar — zero errors, zero warnings

This project deliberately runs the latest stable versions of every component, and the discipline that makes that workable is a hard "no warnings anywhere" rule. Apply it whenever you add code, bump a dep, or finish a task:

- `pnpm install` must finish with no deprecated-subdep warnings, no peer-dep warnings, no ignored-build prompts. If a transitive dep is deprecated and you can't reach it from `package.json`, fix it with a `pnpm.overrides` entry in `pnpm-workspace.yaml` (see the `glob: '^11.0.0'` override).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` must all run clean — zero errors **and** zero warnings, including warning-level lint rules.
- Server and browser consoles must be clean during normal operation. Vue prop warnings, hydration mismatches, deprecation warnings, unhandled rejections — these are bugs, fix the root cause.
- **Don't** silence warnings with `--no-warnings`, lint-rule disables, or `// eslint-disable` unless there is no other option. Document any exception inline with a one-line _why_.
- ESLint enforces `no-console` (errors on `log`/`info`/`debug`; allows `warn`/`error`). Use Fastify's `app.log` or pino on the backend, a logger utility on the frontend.
- Latest stable majors only. Track upstream releases, run `pnpm audit` regularly, address advisories rather than ignoring them.

The README has the full standards section — quote from there when explaining the bar to a contributor.

## TypeScript / lint conventions

- Strict mode is on (`tsconfig.base.json`), plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`. ESM throughout (`"type": "module"`).
- Backend uses `tsx` for dev (no separate compile step), `tsc` for production builds.
- Frontend uses `vue-tsc` (Vue-aware TS compiler) for typecheck.
- ESLint flat config (`eslint.config.js`) covers TS + Vue + Prettier. `pnpm lint` runs across the whole workspace.
- Prefer `import type { ... }` for type-only imports — enforced by `@typescript-eslint/consistent-type-imports`.

## Licensing / file headers

Copyright is held by **Tiger IT Bangladesh Limited** (2026). If you generate source files that conventionally carry a license header, match this attribution.

## Listed agents

The README declares Claude Code and GitHub Copilot as the agents working on this repo. There are currently no `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` files to reconcile against.
