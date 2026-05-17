# ShipShow! Implementation Roadmap

_Codename and package name: `bbstat`._

A phased plan for building out BitBucket ingest and the dashboard surface, designed to deliver value early and minimize BitBucket API calls throughout. Total estimate: **18–22 working days**, fitting "next month" with buffer.

## Operating constraints

- **Workspace shape:** ~500 repos total in the workspace, ~50 actively committed-to on a typical day, ~30 developers.
- **Curated tracked set:** BBSTAT does not ingest all 500 repos. We start with a small **curated list** of repos and grow it gradually. Untracked repos cost zero API calls.
- **BitBucket Cloud rate limit:** ~1000 requests/hour per authenticated identity. With the curated approach, comfortably under-budget across all phases — including diff stats.
- **Auth:** Atlassian API token (Basic auth, username = email). See `memory/bitbucket_cloud_auth.md` for scope details.
- **Architectural rules** (see `CLAUDE.md`): backend never proxies live BitBucket calls on the request path; Redis is for user-summary rollups only; Pinia is the client cache; no auth on BBSTAT itself today.

## API-minimization toolkit

Techniques applied across every phase, not a phase on their own:

1. **Field filtering** — `?fields=values.uuid,values.slug,…` on every list endpoint. Slim payloads.
2. **`pagelen=100`** to maximize per-call yield.
3. **Per-repo sync cursor** in a `sync_state` table — `last_synced_at` + `last_seen_sha`. Subsequent fetches stop as soon as we hit a known sha.
4. **Tiered freshness:** stable data (workspace members, repo metadata) on a slow cadence (6–24h); volatile data (commits, branches) on a fast one (15 min).
5. **API call budget per cron tick** — bounded work per run, surplus deferred. Tracked via response rate-limit headers.
6. **Conditional requests** (ETag / `If-None-Match`) wherever Bitbucket supports them — turns "no change" into a free 304.
7. **Curated tracked set** — only repos in `repositories` table are ingested. Largest API saving in this project.
8. **Webhook over poll** for hot repos once Phase 5 lands — replaces dozens of polling calls/hour with zero-cost push events.

## Phases

### Phase 0 — Foundations (~2 days) ✅ Landed

The plumbing every later phase depends on.

- BitBucket HTTP client: Basic auth (`<email>:<api-token>`), retries with exponential backoff, 429-aware backoff using `Retry-After`, rate-limit budget tracking, field-filter helper.
- Drizzle schema additions: `branches`, `pull_requests`, `sync_state` (per-repo cursor table). `repositories` represents the curated tracked set — no `is_tracked` flag, just presence/absence in the table.
- Generate first real migration, apply via `make db-migrate`.
- Rename env vars: `BITBUCKET_USERNAME` → `BITBUCKET_AUTH_EMAIL`, `BITBUCKET_APP_PASSWORD` → `BITBUCKET_AUTH_TOKEN`.
- Curated seed list lives in `tracked-repos.yaml` at the repo root (gitignored; `tracked-repos.yaml.example` is committed). A top-level `repos:` list of `<workspace>/<slug>` strings bootstraps the curated set on backend startup. Override the file path via `SEED_REPO_FILE_PATH` in `.env`.
- `pnpm doctor` (Makefile: `make doctor`) script that hits `/workspaces/<ws>` and prints a green check — proves end-to-end auth before any sync code runs.

**Deliverable:** doctor passes, migrations applied, no functional sync yet.

**Status:** Landed across `29bc0c3`..`ac18e63` (8 commits including the roadmap doc itself). BitBucket client with retries / 429 backoff / sliding-window call-budget ledger lives at `apps/backend/src/bitbucket/client.ts`; Drizzle schema (`branches`, `pull_requests`, `sync_state`) at `apps/backend/src/db/schema.ts` is mirrored by Flyway-style SQL under `apps/backend/schema/`; `make doctor` proves BB auth end-to-end via `apps/backend/src/scripts/doctor.ts`. The curated seed list originally shipped as a `SEED_TRACKED_REPOS` env var and was refactored to `tracked-repos.yaml` with hot-reload in `2d439d6` during Phase 2 cleanup.

### Phase 1 — Workspace + curated repo bootstrap (~2 days) ✅ Landed

Get the curated set into the database; enumerate users.

- Sync workspace members → `users`. Single paginated call set (~30 devs / 1 page). Runs every ~24h.
- On startup (and on every `runReposSync` / `runDiscoverySync`), reconcile `repositories` against `tracked-repos.yaml`: insert any missing rows, fetch fresh metadata per repo (`/repositories/{ws}/{slug}` — 1 call each, only for new entries). The re-read on each sync means YAML edits land without a restart.
- Admin endpoint: `POST /api/admin/repositories` to add a repo to the curated set (idempotent; queues first backfill).
- Field-filter heavily on every list call: `uuid`, `slug`, `name`, `project.key`, `updated_on`.
- Manual trigger: `POST /api/admin/sync/discover` — re-syncs members and repo metadata.
- Cron path of `runSync()` enabled at slow cadence for users + repo metadata.
- Dashboard: real counts replace stub data ("Tracking N repos across M projects, K developers").

**API budget:** ~5–10 calls per slow refresh cycle. Daily total ≪ 1% of the rate limit.

**Status:** Landed across `90d2958`..`11b10f2` (4 commits). Discovery domain logic in `apps/backend/src/sync/discovery.ts` is shared by the slow-cadence cron (`SYNC_MEMBERS_CRON`, `SYNC_REPOS_CRON`), the manual `POST /api/admin/sync/discover`, and the per-repo `POST /api/admin/repositories` add path — all converging on the same `runSync()` entrypoint. The `BitbucketClient.paginate()` async iterator landed here and is consumed by every list endpoint downstream. Dashboard's overview endpoint reads real Postgres counts.

### Phase 2 — Commit ingest (~5–6 days) ✅ Landed

The core data source. Most of the API-minimization care lands here.

- Per-repo delta pull keyed off `sync_state.last_seen_sha`:
  - First run per repo: paginated full pull, capped to N pages or a `since` date (configurable). Idempotent.
  - Subsequent runs: stop when we hit a known sha. Idle repos cost 1 call.
- Author resolution: `commits.author_user_id` joined via BitBucket UUID against `users`; gracefully handle anonymous / unmatched commits.
- **Metadata only this phase** — `sha`, `message`, `authored_at`, `parents`. **No diff stats yet** — even with a comfortable budget, those add a per-commit dimension worth isolating into its own phase to keep this one small.
- Cron every 15 min, concurrency 3–5 repos in parallel, respecting rate-limit budget.
- Manual per-repo re-sync endpoint.

**API budget:** ~50 active repos × ~4 ticks/hour × 1–2 calls each ≈ 200–400 calls/hour. Idle days drop to <100 calls/hour.

**Deliverable:** dashboard shows real commit counts, latest commit per repo, top contributors.

**Status:** Landed across `09b86c1`..`412525b` (7 commits). Operator + reader notes — modes, cursor guarantees, budget gate, all env knobs, admin + dashboard endpoints — live in [`docs/sync.md`](sync.md). Frontend dashboard now shows 5 stat cards plus a Top Contributors panel with a 7d/30d window toggle.

### Phase 3 — Rollups + Redis user-summary cache (~3–4 days) ✅ Landed

Dashboard reads from pre-computed summaries, not raw aggregations on every page load. **Zero new API calls — pure local compute.**

- One Postgres rollup table — `commit_daily(day, repository_id, author_user_id, commit_count, additions, deletions)` with `UNIQUE NULLS NOT DISTINCT` on the key so anonymous-author commits collapse to one row per `(day, repo)`. Per-user / per-repo / per-project rollups are SQL aggregations off this single base, not separate tables.
- After each successful per-repo commit sync, the rollup is recomputed for the touched day range and the affected users' Redis cache entries are DEL'd. Recompute runs before invalidation so concurrent reads always repopulate from fresh data. The "Redis is for user summaries only" rule from `CLAUDE.md` is now active — Redis key prefix `bbstat:user-summary:{id}`, 1h TTL.
- Backend endpoints under `/api/stats/`: `users/:id/summary`, `projects/:projectKey`, `repositories/:ws/:slug/activity`, plus `repositories` (dashboard listing).
- Frontend: keyed Pinia stores (`userSummary`, `projectStats`, `repoActivity`) hydrate from these endpoints, persist across reloads, and back three new detail pages reachable from the dashboard's Top Contributors / Projects / Tracked Repositories panels.

**Status:** Landed across `3dacb15`..`d4fd42d` (14 commits). Operator notes — rollup mechanics, drift conditions, cache invalidation, all six dashboard endpoints, and the `make rebuild-rollups` repair script — live in [`docs/sync.md`](sync.md). Frontend now has user / project / repo detail pages all reachable from the dashboard, and the legacy `/overview` + `/top-contributors` endpoints read from `commit_daily` so latency stays flat as the commit log grows.

### Phase 4 — Code-change volume + activity feed (~3–4 days) ✅ Landed

Layer the "expensive" metrics in once cheap ones are stable.

- Diff stats: opt-in per repo. 1 API call per **new** commit (skipped for backfilled history). Persisted to `commits.additions/deletions`. Throttled inside the API-budget machinery from Phase 2.
- Pull request ingest using the same delta pattern.
- Activity feed: time-ordered join of commits + PRs → `/api/activity`.
- Dashboard: per-user sparklines, activity log component, filters by project/repo/user.

**API budget:** ~50 active repos × ~10 new commits/day average ≈ 500 diff-stat calls/day = 21/hour. Comfortable.

**Status:** Landed across `27528fe`..`96a6256` (11 commits). Operator notes — diff-stats opt-in via YAML, PR-sync cadence + cursor mechanics, `/api/activity` query params, every new env knob — live in [`docs/sync.md`](sync.md); per-stream design rationale lives in those commits' messages. Dashboard now has a tabbed Top Contributors / Recent Activity panel with per-user 30-day sparklines and project/repo/user filter dropdowns; the activity feed is mounted on user / project / repo detail pages too. Backend pipeline ingests PR state on an hourly cron and (opt-in per repo) per-commit diff stats inside the commit tick.

#### Phase 4 follow-ups — backpressure algorithm + dashboard polish ✅ Landed

Post-Phase-4 ops work driven by running the sync at 160-repo scale and hitting BB Cloud's burst limiter.

- **Self-queueing deepen-backfill** (`apps/backend/src/sync/deepen-backfill.ts`): every commit tick piggybacks a derived queue from `sync_state WHERE deepen_complete = false`, ordered by `deepen_last_run_at ASC NULLS FIRST`. Walks history backwards from each repo's oldest sha, marks `deepen_complete` when BB returns no more `next` URLs, drains until the budget runs out. Rolls up `commit_daily` + invalidates user-summary cache after every batch.
- **Adaptive call pacing**: `BitbucketClient` now tracks `currentPacingMs` that doubles on every 429 (400 → 800 → 1600 → 3200) and decays after 20 clean responses. Sticky across ticks. Defends against BB's undocumented sub-second burst limiter.
- **Tick-wide rate-limit abort**: when retries exhaust at the pacing ceiling, both commit-tick and deepen-tick catch `BitbucketRateLimitError`, unshift the failing repo back to the queue head, and yield to the next cron firing with `stopReason: 'rate-limited'`. Fairness across ticks via `last_synced_at ASC NULLS FIRST` ordering.
- **Misc sync fixes**: PR endpoint pagelen 100→50 (BB's documented cap for `/pullrequests`), deepen-tick rotation-complete guard to prevent infinite loops when every candidate has `oldestSha = null`.
- **Dashboard sync state**: per-repo `RepoSyncStatus` ('ok' / 'error' / 'never') derived from `sync_state.last_sync_status` and rendered as a tiny check / warning / dash icon next to every repo across the dashboard, project, user, and repo pages.
- **Top contributors share bar**: 24px-tall blue-gradient bar showing each contributor's share of workspace commits in the active 7d/30d window. Vertical dividers, hover sheen animation, whole-row clickable link.
- **Table improvements**: per-repo `contributors30d` column on the project detail page; First/Last buttons added to all paginated tables; project detail repos table paginated at size 10; sparkline + clickable row added to the repo detail page's contributors list.
- **New stat cards**: dashboard "Commits last 30 days"; user detail "Repositories — all time" (distinct count).
- **Project activity heatmap**: `CommitHeatmap` mounted on project detail pages with project-scoped `dailyCommits` aggregate.
- **Algorithm doc** (`docs/sync.md`): "Backpressure algorithm" section explaining the 5-layer defense (self-counted budget, adaptive pacing, tick abort, fair round-robin, and adaptive per-repo backoff for quiet repos) plus a "Tick execution order" tree, and a "Tuning playbook" mapping log symptoms to knobs.

#### Phase 4 follow-ups — Workspace Members page + git-author email + cache versioning ✅ Landed

Standalone roster page reachable from the Dashboard's "Workspace Members" stat card, plus the supporting plumbing.

- **`GET /api/stats/members?window=7d|30d`** — single 4-CTE query (base / last_active / daily / spark) returning the full eligible roster (`HAVING sum(commit_count) > 0`; archived / sync-excluded repos filtered). Powers the page in one round-trip; fuzzy search, sort, pagination all run on the frontend over the cached payload.
- **`/members` page** (`apps/frontend/src/views/Members.vue`) — Fuse.js fuzzy search across `displayName` / `username` / `email`, sortable columns, 100-per-page client-side pagination, per-row 30-day sparkline, vertical separator between window-scoped and window-independent columns. SSE wiring (`tick.commits.complete` + `repository.deleted` + fallback) keeps it fresh.
- **Two aggregate charts** above the table: activity-status donut (recency buckets 7d / 30d / 90d / dormant, mutually exclusive partition; emerald / blue / amber / slate) and Lorenz commit-concentration curve with a Gini coefficient badge. Both pure SVG, no external charting dep.
- **Dashboard stat-card entry** with a 3D hover tilt (`perspective:1200px` + composite `rotateX/rotateY` transform) and a Heroicons "users" glyph that color-flips to `blue-500` on hover.
- **Git-author email capture** — new nullable `users.email` column populated from `commits.author.raw` at ingest time, write-once via `COALESCE`. Parser (`apps/backend/src/sync/author-email.ts`) filters BB / GitHub `noreply` synthetics. Plumbed into both forward commit-sync and deepen-backfill. Surfaced in `WorkspaceMember.email`, `UserSummary.user.email`, and the Members row / user-detail header (UUID stays as the `font-mono` fallback when email is null).
- **Retroactive admin backfill** — `POST /api/admin/users/backfill-emails?limit=N` walks every NULL-email user's most recent ingested commit (`DISTINCT ON (author_user_id)`, archived / excluded repos filtered), fetches that one commit via `paginateCommits({include: sha})`, parses and bulk-writes. Default cap 500, hard cap 2000. One-shot, idempotent.
- **`CACHE_VERSION` boot-time bust** — `bustStaleCacheIfNeeded()` wipes every `bbstat-*` prefixed localStorage key when the in-code version mismatches the sentinel. Pinia persistedstate is configured globally with the `bbstat-` prefix so new stores auto-participate. Eliminates the "stale persisted shape renders against new component code" failure mode that hit twice during this work.
- **Migration**: `ALTER TABLE users ADD COLUMN email text` (Drizzle `0012_cold_champions.sql` + Flyway `V1_13__add_users_email.sql`).
- **Docs**: [`docs/members.md`](members.md) covers the page surface, charts, SSE, email capture + backfill, and the change-checklist for member-facing shapes; [`docs/frontend-cache.md`](frontend-cache.md) covers the `CACHE_VERSION` mechanism with side-effect analysis.

**Status:** Landed across `297548d`..`09802b8` (5 commits). Members page, charts, SSE / sparkline, email + admin backfill, and `CACHE_VERSION` cache invalidation.

### Phase 5 — Webhook trigger + admin UI (~3–4 days, stretch)

Kill polling for hot repos; give operators visibility and self-service.

- Add `write:webhook:bitbucket` to the API token.
- One-time bootstrap: register webhook per tracked repo. Receiver verifies signature and dispatches `runSync(trigger='webhook', repositorySlug=…)`.
- Cron cadence drops from 15 min → 1h (safety net for missed webhooks). Big API savings.
- Admin UI: per-repo sync state, manual re-sync button, recent sync runs + errors, **add-repo picker** that browses the broader workspace (uses workspace-wide repo enumeration as a one-shot list call, not persisted).
- **Requires a public URL** — needs ngrok during dev or wait for a staging deploy. Decide at the start of the phase.

## Curated list growth

The "start small, expand gradually" approach has a clear path:

1. Seed via `tracked-repos.yaml` at first install (Phase 0–1); hot-reloaded on every discovery sync.
2. Admin endpoint to add repos (Phase 1) — usable via `curl` immediately.
3. Admin UI with workspace browser to pick repos (Phase 5).
4. Removal: keep historical commits but stop syncing — soft-delete via `repositories.tracked = false` if/when needed; not in initial scope.

## Open future considerations (not scheduled)

- **Login with BitBucket / OAuth** — explicitly deferred. Schema and APIs leave a seam for `userId` / actor identity but no flow is built.
- **Multi-workspace support** — currently scoped to one workspace via `BITBUCKET_WORKSPACE`. If we add a second, schema needs `workspace_id` propagated.
- **Service-account credential** — the current API token is personal. For long-running production deploy, switch to a workspace-owned token or service account.
- **Production deploy / Traefik** — `etc/tls/` and `docker-compose.yml` are dev-only. Production would terminate TLS at Traefik, run sync as a separate service, etc.
- **Deprecated transitive deps** — `pnpm install` warns about a handful of deprecated subdeps (currently `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, an older `glob` reachable via `tsx`'s dependency chain). Our own code is clean and our `pnpm.overrides` already pin `glob` to v11; the residue is upstream-owned. Worth a revisit once `tsx` / its deps ship modern replacements — at that point bump or swap and drop overrides.
- **Move "rebuild rollups" to an authenticated admin endpoint** — currently shipped as `make rebuild-rollups` because there's no auth yet. Once OAuth lands, lift `RollupStore.rebuildAll()` into `POST /api/admin/dashboard/rebuild-rollups` (the SQL stays untouched; route is ~5 lines).
