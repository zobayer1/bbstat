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

## Authentication

**Currently: none — by design.** Everyone in the deployed environment sees everything; the explicit goal is to drive intra-org transparency and competitiveness. Do not add login flows, session middleware, or per-request auth checks unless explicitly asked.

**Planned: "Login with BitBucket"** (OAuth against BitBucket). When this lands it will replace the open access model, so:

- Don't bake assumptions about anonymous access deeply into APIs or schemas — leave a seam where a `userId` / actor identity can be plumbed through later (request context, audit columns).
- Don't pre-build the OAuth flow speculatively either; wait until it's the active task.

## Repo layout

```
bbstat/
├── apps/
│   ├── backend/        # Fastify HTTPS API + sync runner (Node.js, TS, Drizzle, Redis, Vitest)
│   └── frontend/       # Vue 3 SPA (Vite, Pinia, vue-router, Tailwind 4, Vitest)
├── etc/tls/            # Local self-signed CA + server cert for bbstat.localhost (NOT committed)
├── docker-compose.yml  # postgres + redis for local dev
├── eslint.config.js    # Flat config, applies to all workspaces
├── tsconfig.base.json  # Shared strict TS settings
├── pnpm-workspace.yaml # Workspaces: apps/*, packages/*
├── .env.example        # Copy to .env at repo root for both apps
└── tracked-repos.yaml.example  # Copy to tracked-repos.yaml — curated seed list (gitignored)
```

There is no `packages/*` yet. If shared TS types between backend and frontend become useful, that is where they'd land (e.g. `packages/shared`).

## Common commands

The root `Makefile` is the canonical entry point — prefer `make <target>` when one fits. Run `make help` to list everything. Common ones:

```bash
make install                 # pnpm install (all workspaces)
make up         / make down  # docker compose up -d / down (postgres + redis)
make ps         / make logs  # service status / tail logs
make reset                   # docker compose down -v (wipes pg/redis volumes)

make dev                     # backend + frontend in parallel (HTTPS)
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
5. **Postgres + Redis** — start via `docker compose up -d` before running the backend.

## Local TLS (`etc/tls/`)

Self-signed CA and server certificate for local HTTPS. **These files are gitignored** (`etc/tls` line in `.gitignore`) — they are per-developer fixtures, not committed material. If the directory is empty on a fresh clone, regenerate using OpenSSL with the `server.san` config (CN: `bbstat.localhost`, SAN: `bbstat.localhost`, `localhost`, `127.0.0.1`).

Both Vite and Fastify load these at startup:

- Backend: `apps/backend/src/index.ts` reads `TLS_KEY_PATH` / `TLS_CERT_PATH` (env-overridable, default `etc/tls/server.key` / `server.crt` relative to repo root).
- Frontend: `apps/frontend/vite.config.ts` reads the same files.

Do **not** regenerate `ca.crt` / `ca.key` casually once developers have trusted them — they'll have to re-trust the new CA. Server cert can be re-issued from the same CA without breaking trust.

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
