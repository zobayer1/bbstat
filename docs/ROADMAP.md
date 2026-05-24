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
8. **Webhook over poll** for hot repos once Phase 7 lands — replaces dozens of polling calls/hour with zero-cost push events. Currently deferred behind authentication / public-URL work (see Phase 7).

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

#### Phase 4 follow-ups — dedicated `/activity` page + dashboard polish ✅ Landed

Standalone activity-stream page reachable from the Dashboard's three commit cards, plus filter / chart / UX polish across the surrounding surfaces.

- **`/activity` page** (`apps/frontend/src/views/Activity.vue`) — full unified commit + PR stream with project / repository / user dropdowns, date-range picker (defaults the "to" bound to today), single-input hash-or-message search (auto-detects mode by hex regex), 100-per-page offset pagination with First / Prev / Next / Last in a top + bottom row, and a 365-day year-grid `CommitHeatmap` scoped only by project / repo / user (date / hash / message filters don't narrow it). H1 chips out the active range with the matching stat-card tone (yellow-600 / green-600 / red-600) when the URL matches one of the three Dashboard shortcuts.
- **Backend additions**: `/api/activity` accepts `after`, `hashPrefix`, `message`, `offset` on top of the existing filters; new `/api/activity-count` returns `{ total }` for the same filter shape (powers the page-count indicator + Last button); new `/api/activity-daily` returns 365 days of `{ date, commits }` from `commit_daily` for the heatmap. Commit-message search is backed by a `tsvector` generated column (`message_tsv`) + GIN index; hash-prefix search by a `text_pattern_ops` btree on `sha`.
- **Filter interlock composable** (`apps/frontend/src/composables/useActivityFilters.ts`) — picking a repo auto-fills its project, picking a project trims the repo dropdown and clears a now-mismatched repo selection. URL-synced, single-replace per change. Used by Dashboard, Activity, and User detail pages; the Project detail page uses the same composable with `pinProject` to keep the repo dropdown scoped without dragging the (already-pinned) project into the query string.
- **Detail-page filters** — Activity panels on user / repo / project detail pages now carry the two filters not pinned by the route (User → project + repo, Project → repo + user, Repo → user only since its project is fixed). User options come from each page's own contributor list when one exists.
- **Dashboard stat-card refresh** — row 2 reordered to `Commits last 7 days / 30 days / all-time`, each card a `StatCard3D` with a Heroicons glyph and per-card tilt; tones follow CMY-RGB with Workspace Members keeping its original blue. The three commit cards link to `/activity` with the matching `?after=` window pre-applied. Activity tab gains a `More →` footer that mirrors the Top Contributors footer (members link / activity link with 7-day range).
- **Members subtitle reconciliation** — Members page header surfaces both the active and workspace-total counts so the page no longer reads as a count mismatch when arriving from the Dashboard's "Workspace Members" card.
- **Migration**: `ALTER TABLE commits ADD COLUMN message_tsv tsvector GENERATED ALWAYS AS …` + GIN + btree (Drizzle `0014_outstanding_sue_storm.sql` + Flyway `V1_15__commits_message_fts_and_sha_prefix.sql`).
- **Docs**: [`docs/sync.md`](sync.md) covers the extended `/api/activity` query schema and the two sibling endpoints (`/api/activity-count`, `/api/activity-daily`).

#### Phase 4 follow-ups — Projects / Repositories index pages + hero refresh ✅ Landed

Two new top-level index pages, the supporting backend rollup, and a public-facing polish pass: dashboard hero mascot, global footer with contact + last-sync, "View on BitBucket" anchors across every list/detail page, and a scoped heatmap palette so the three contexts the chart shows up in are visually distinct.

- **`/projects` page** (`apps/frontend/src/views/Projects.vue`) — searchable, sortable table of every BitBucket project with totals, sync mix, and a workspace-wide sunburst (`SunburstRepoContributors.vue`) showing top repos × top contributors. Powered by a new `GET /api/stats/repo-contributors` (top-N repos × top-M contributors over a trailing window, optional `project` scope) so the project detail page reuses the same chart over a single project's repos. ProjectStats `topContributors` upgraded to the enriched repo-style shape (30-day sparkline + adds/dels excluding merges); legacy `weeklyCommits` field dropped.
- **`/repositories` page** (`apps/frontend/src/views/Repositories.vue`) — searchable / sortable / project- and status-filtered table, plus a sync-health panel: a 3D-tilted donut (legend on the left, percent column dropped) sitting in a 40 / 60 split with a top-5 compound bar chart that breaks each repo's 30-day churn into green-add / red-del segments. Bars carry a staggered left-to-right sheen sweep. New `TrackedRepositorySummary.additions30d / deletions30d` fields drive the bar split.
- **Dashboard hero** — boat-carrying-the-poop-emoji SVG mascot floating in a full-width water band (two layered wave paths with irregular peaks + slow left-to-right sheen sweep); title + subtitle anchored to the bottom of the hero so the subtitle baseline sits just inside the wave-line.
- **Global page footer** (`apps/frontend/src/App.vue`) — contact `mailto:` (driven by `VITE_CONTACT_EMAIL`) on the left + last-synced indicator on the right, rendered on every route via the root component. Replaces the inline "Last synced" pill that used to sit in the Dashboard header.
- **Cross-page polish** — "View on BitBucket ↗" anchors on Projects / Repositories / Members + project breadcrumb on the repo detail page; chart titles on the Members page centered; `CommitHeatmap` gains a `scope` prop with workspace-blue / per-user-violet / per-repo-emerald palettes so the three contexts the chart shows up in are visually distinct; `useUserSummaryStore` subscribes to `repository.sync-excluded` / `repository.included` so the user-detail "Top repos" sync-state icons flip live.
- **`ActivityStatusDonut`** generalised — `legendPosition` (`left` / `right` / `below`), opt-in `tilt3d` (CSS perspective + drop-shadow + gloss overlay), opt-in `showPercent`, and a CSS-grid legend that right-aligns counts in their own column without widening the legend block.
- **Cache**: `CACHE_VERSION` bumped 2 → 5 — `ProjectStats.topContributors` shape change, `RepoActivity.repository.project` addition, and `TrackedRepositorySummary` adds/dels. Operators should pair this deploy with `docker compose exec redis redis-cli FLUSHDB` per the Redis-bust rule (the `UserSummary` shape itself is unchanged, but the rule's "any `bbstat:*` shape change" coverage applies because the sync also touches `commit_daily`-driven aggregates).
- **Docs**: [`docs/sync.md`](sync.md) gains the `/api/stats/repo-contributors` row in the endpoint table.

### Phase 4.5 — ShipShow Score + leaderboard ✅ Landed

Per-developer ranking metrics layered onto the existing rollups — no new BitBucket ingest, pure local compute over `commits`.

- **Scoring engine** (`apps/backend/src/scoring/`): split-log per-commit score with p95-capped churn floor; 30-day-half-life decayed `score_trending`; un-decayed `volume_7d / 30d / 90d / 365d / all`; 90-day `consistency` from active-day gap CV; six personality badges (`fresh_meat`, `deep_diver`, `ai_alex`, `cleanup_crew`, `batch_betty`, `steady_eddie` catch-all) with momentum-ranked Steady Eddie tiers (`bronze` / `silver` / `gold`). Pure functions, deterministic, fully unit-tested.
- **`user_score` rollup table** + `user_badge` / `user_badge_tier` enums. Recomputed at the tail of every commit-sync tick; manual rebuild via `POST /api/admin/scores/recompute` (or `make recompute-user-scores`).
- **Members page as leaderboard** — `scoreTrending` is the default sort; Momentum / 7d / 30d / 90d / 365d / all-time volume columns plus a `BadgeIcon` column with tier-tinted circular backgrounds for Steady Eddie. Search / sort / paginate all client-side over the cached payload.
- **Methodology modal** — KaTeX-rendered formulas (split-log scoring, decay, consistency, badge cascade) reachable from the Members page header for non-engineer audiences.
- **Member persona categorization** — three tiers surfaced in the UI: **active workspace members** (`is_workspace_member = true`, `is_dormant = false`), **dormant workspace members** (`is_workspace_member = true`, `active_days_90d = 0` — row grayed via `is_dormant`), **ex-members / external contributors** (`is_workspace_member = false` — red-tinted email line, auto-created during commit ingest when BB attributed a commit to a UUID we'd never seen in `/workspaces/{ws}/members`). The flag flips back to `true` the moment they reappear in member sync, so rejoiners self-heal.
- **Merge-exclusion fix** — `commit_daily.commit_count / additions / deletions` now exclude `is_merge = true` rows; a new `merge_commit_count` column carries the merge tally separately so repo-level "all commits" reads stay correct without double-counting authorship.

**Status:** Landed across `f6c0b8c`..`be739f9` (12 commits). See [`docs/scoring.md`](scoring.md) for the algorithm, schema, badge cascade, and operator notes.

### Phase 5 — User alias merge (planning TBD)

One human, many `bitbucket_uuid`s. Today a contributor who pushes from a personal account and a corp account shows up as two `users` rows with disjoint commit histories; aggregates split and leaderboards under-count them. This phase reconciles those identities.

- Design open: operator-curated alias table vs. auto-detect-by-email, how to recompute rollups after a merge, whether to keep history on the alias path or rewrite `author_user_id` in place.
- No schema yet — `aliases` table shape and migration plan are part of the planning step.
- Blocks Phase 4.5's scoring accuracy at the long tail (anyone with multi-account history is currently under-scored).

### Phase 6 — Org-email auth + BitBucket account linking (planning TBD)

Bridge org identity (Workspace SSO / Google / Microsoft) to BitBucket identity so a logged-in user is bound to one or more `users` rows from Phase 5.

- Design open: which OIDC provider, what the linking flow looks like, where the binding lives (`user_org_identities` table seems likely), how to handle users who log in but have no matching BB commits yet.
- Depends on Phase 5 to define the canonical-user concept the org-side binding points at.
- Still **no per-request auth gate** at this phase — adds the identity plumbing without flipping the dashboard from open to gated. The gate flip happens in Phase 7.

### Phase 7 — Authentication + webhook trigger + admin UI

Flip the dashboard from open to gated, take advantage of the public URL that auth requires to also stand up webhooks, and ship the first operator surface.

- Per-request auth gate enforced via the Phase 6 identity plumbing. Admin endpoints get a real role check (today they're open-by-design — see `CLAUDE.md`).
- **Webhook trigger** (originally Phase 5): add `write:webhook:bitbucket` scope, one-time bootstrap to register webhooks per tracked repo, signature-verifying receiver that dispatches `runSync(trigger='webhook', repositorySlug=…)`. Cron cadence drops from 5 min → 1 h once webhooks are live; the polling tick stays as a safety net for missed events.
- Admin UI: per-repo sync state, manual re-sync button, recent sync runs + errors, **add-repo picker** that browses the broader workspace (workspace-wide repo enumeration as a one-shot list call, not persisted).
- **Requires a public URL** — the same dependency that drives webhook readiness drives the OIDC redirect. Today the deploy lives on `bbstat.onudaan.com`, only reachable from the local network, which is why webhooks are still parked. Decide between ngrok-for-dev vs. a staging deploy at the start of the phase.

### Phase 8 — Admin dashboard (planning TBD)

Operator console for the now-authenticated surface from Phase 7. Stretch / nice-to-have.

- Design open: in-app `/admin` route vs. separate app, which Phase-7 admin endpoints get UI surfaces vs. stay curl-only, whether the audit log is a new table or just structured logs.
- Likely surfaces: alias merge UI (Phase 5), org-identity link inspector (Phase 6), webhook health / re-bootstrap (Phase 7), per-repo backfill controls, scoring threshold tuning preview.

## Curated list growth

The "start small, expand gradually" approach has a clear path:

1. Seed via `tracked-repos.yaml` at first install (Phase 0–1); hot-reloaded on every discovery sync.
2. Admin endpoint to add repos (Phase 1) — usable via `curl` immediately.
3. Admin UI with workspace browser to pick repos (Phase 8).
4. Removal: today, archive via `POST /api/admin/repositories/:ws/:slug/archive` (Phase 4 follow-up — keeps history, stops sync). Hard delete via `DELETE /api/admin/repositories/:ws/:slug` for the "this repo was a mistake" case.

## Open future considerations (not scheduled)

- **Multi-workspace support** — currently scoped to one workspace via `BITBUCKET_WORKSPACE`. If we add a second, schema needs `workspace_id` propagated.
- **Service-account credential** — the current API token is personal. For long-running production deploy, switch to a workspace-owned token or service account.
- **Deprecated transitive deps** — `pnpm install` warns about a handful of deprecated subdeps (currently `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, an older `glob` reachable via `tsx`'s dependency chain). Our own code is clean and our `pnpm.overrides` already pin `glob` to v11; the residue is upstream-owned. Worth a revisit once `tsx` / its deps ship modern replacements — at that point bump or swap and drop overrides.
- **Move `make rebuild-rollups` and `make recompute-user-scores` to authenticated admin endpoints** — currently shipped as scripts because there's no auth yet. Once Phase 7 lands, lift `RollupStore.rebuildAll()` into `POST /api/admin/dashboard/rebuild-rollups` alongside the existing `POST /api/admin/scores/recompute` (the SQL stays untouched; route is ~5 lines).
- **Auto-adjusting badge thresholds** — Phase 4.5 badges use static cutoffs calibrated against the live corpus on 2026-05-21. Percentile-based thresholds become attractive once the org doubles or the static cuts misclassify obvious cases. Spec lives in [`docs/scoring.md`](scoring.md) "Things deliberately out of scope".
