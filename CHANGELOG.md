# Changelog

All notable changes to this project are documented here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not
strictly SemVer-versioned but releases are tagged in git and each tagged
release gets a section.

## [Unreleased]

Nothing queued yet.

## [1.3.0] — 2026-06-09

Operator-facing reliability + clarity: surgical recovery for broken repo
syncs, self-healing for empty repos, and a Repositories page that stops
crying wolf on benign states — plus the person-layer merge tooling queued
since 1.2.0 and a scoring-methodology write-up. **No schema change**;
`CACHE_VERSION` 20 → 21 (auto-busts on each user's next load). The deploy
needs no data migration, no Redis clear, and no new env vars — see the
runbook below.

### Added

- **Surgical history-rewrite recovery** (`POST /api/admin/repositories/:workspace/:slug/reconcile`)
  — when a force-push rewrites the commit a repo's sync cursor points at, the
  sync auto-excludes it (`history-rewritten`). Reconcile diffs BitBucket's head
  against our stored commits, deletes only the orphaned (rewritten-away) shas,
  re-anchors the cursor to the common ancestor, and delta-syncs just the new
  commits — no full re-walk, no diff-stat re-fetch. Dry-run by default (returns
  the plan: ancestor, orphan shas, new-commit count); `?dryRun=false` applies.
  Scoped to the `history-rewritten` state (`409` otherwise); `422` when the
  rewrite is deeper than the search window. See [`docs/admin.md`](docs/admin.md).
- **Empty-repo revival sweep** — a repo auto-excluded as `empty-on-bitbucket`
  is never re-polled, so a later first push went unnoticed until an operator
  manually re-included it. A new sweep (a gated step in every commit-sync tick,
  plus on-demand `POST /api/admin/sync/revive-empty`) re-probes empty-excluded,
  non-archived repos with one cheap BB call each and clears the exclusion the
  moment one has commits, so the repo self-heals back into the rotation.
  Archived repos are skipped — archiving is a deliberate retire. Reuses
  `DEEPEN_BUDGET_THRESHOLD`; no new env vars.
- **Repository-health clarity on the index** — the Repositories page now
  distinguishes benign states from problems. Archived repos carry an
  "Archived" badge (new `TrackedRepositorySummary.archived`), and
  `empty-on-bitbucket` exclusions render as a benign gray "Empty" (new
  `RepoSyncStatus` value) that drops out of the Issues tab instead of a red
  "needs attention" mark. Genuinely-broken exclusions (`repo-404`,
  `history-rewritten`) stay red.
- **Duplicate-candidate finder** (`apps/backend/src/scripts/find-duplicate-candidates.ts`)
  — read-only script that scans `users`, normalizes display names + emails, and
  prints ranked clusters of likely-duplicate accounts to speed up person
  merges. Matching is IDF-weighted and typo-tolerant: a shared common surname
  barely counts while a shared distinctive given name dominates, so it doesn't
  collapse a whole org's `<x> Islam` rows into one blob. Run via
  `make find-duplicates` (dev) or, in prod, the compiled
  `dist/scripts/find-duplicate-candidates.js` through the backend image. See
  [`docs/people.md`](docs/people.md) "Finding merge candidates".

### Changed

- **`CACHE_VERSION` 20 → 21** — `TrackedRepositorySummary` gained `archived`,
  and `RepoSyncStatus` gained the `empty` value (both for the Repositories-page
  benign-state distinctions above). The boot-time bust wipes stale `bbstat-*`
  localStorage on each user's next load.

### Fixed

- **Person-layer cache invalidation now busts the whole alias roster.**
  `attach` / `detach` previously DEL'd only the single named alias's
  `bbstat:user-summary:*` key, and `PATCH` (rename) / `primary` busted nothing
  — so a sibling alias's `/users/:id` page kept serving a stale person name or
  an empty "Linked accounts" table until the 1h TTL. All four mutations now
  invalidate every alias in the affected person's roster (rename / primary
  still skip the score recompute, since they don't change attribution).

### Documentation

- **ShipShow Score time-constant design review** ([`docs/scoring.md`](docs/scoring.md))
  — recorded the rationale for momentum's 30-day half-life vs consistency's
  90-day window (the asymmetry is principled, not an oversight), the known
  limitation that consistency is a trailing-window trait with no recency
  weighting, and `BETA` (0.25) as the first tuning knob if the pace factor ever
  needs more teeth.

### Operator notes — deploy runbook (1.2.0 → 1.3.0)

Same containerized stack as 1.2.0: `compose.yaml`, externally-managed Postgres
and Redis, and a distroless backend image with a `node` ENTRYPOINT (pass
`dist/<script>.js` directly, never prefix with `node`). **1.3.0 is a light
deploy: no schema migration, no Redis clear, no new env vars.**

1. **Build + ship images** (build host):
   ```bash
   BACKEND_IMAGE=bbstat-backend:v1.3.0 FRONTEND_IMAGE=bbstat-frontend:v1.3.0 make build-images
   docker save -o bbstat-v1.3.0.tar bbstat-backend:v1.3.0 bbstat-frontend:v1.3.0
   scp bbstat-v1.3.0.tar compose.yaml prod:/opt/bbstat/
   ```
   The frontend image bakes `CACHE_VERSION=21`; the backend image carries
   `/reconcile`, `/sync/revive-empty`, and the empty-revival sweep step.
2. **Load images** (prod):
   ```bash
   docker load -i bbstat-v1.3.0.tar
   export BACKEND_IMAGE=bbstat-backend:v1.3.0 FRONTEND_IMAGE=bbstat-frontend:v1.3.0
   ```
3. **Roll out:**
   ```bash
   docker compose -f compose.yaml up -d
   docker compose -f compose.yaml logs migrate   # no new migration in 1.3.0 — V1_4 is the latest; the migrator is a no-op
   ```
4. **No data action required.** 1.3.0 adds no columns and changes no
   Redis-cached (`bbstat:*`) shape, so there is nothing to rebuild or clear; the
   frontend `CACHE_VERSION` 20 → 21 bust runs automatically on each user's next
   load.

> **Carry-forward caveat:** if the **1.2.0** deploy's required rollup rebuild
> (`rebuild-rollups.js` — step 4 of the 1.2.0 runbook, for the 1.1.0
> merge-exclusion fix) was skipped on this database, run it now. 1.3.0 itself
> doesn't need it, but the merge-inflated `commit_daily` counts persist until
> it's done.

## [1.2.0] — 2026-05-25

Completes the Phase 5 **person layer**: the alias-merge mechanics shipped in
1.1.x's Phase 5 commits, but person-awareness only reached the `/members`
leaderboard. 1.2.0 extends it to **every** contributor surface — Top
Contributors, the repository and project detail pages, multi-actor activity
filtering, and the Person/User detail pages — so a merged person collapses
its aliases everywhere, never just in one place. All commit counts continue
to exclude merge commits. No schema change since 1.1.x's V1_4; the only data
action this deploy needs is a rollup rebuild (carried over from the 1.1.0
merge-exclusion fix) + a Redis flush. See the deploy runbook below.

### Added

- **Top Contributors person-awareness** — the dashboard panel
  (`getTopContributors`) now keys on the merged entity (`TopContributorEntity`:
  `entityKind` / `entityId` / `attachedUserIds`). A merged person appears once
  with a violet `×N` pill and links to `/people/:id`; unattached users link to
  `/users/:id`. (Closes a Phase 5 deferral.)
- **Multi-actor activity filtering** — `/api/activity`, `/api/activity-count`,
  and `/api/activity-daily` accept `actor` + `actorKind` (`user` | `person`,
  default `user` for backward compatibility). A person actor expands
  server-side to every attached alias (`author_user_id IN (SELECT id FROM users
WHERE person_id = …)`). Shared `ActorPicker.vue` (Fuse combobox over the
  person-aware roster) + `useActorFilter` composable replace the per-page user
  `<select>`s on Dashboard / Activity / Project / Repo detail pages. The
  Activity page title chip resolves a person _or_ user identically. (Closes a
  Phase 5 deferral.)
- **Person detail activity feed** — `/people/:id` now carries the unified
  commit + PR stream (pinned to the person, expanded across aliases) with
  project / repo filters, plus a **Last active** column on the Attached
  accounts table (per-alias `MAX(authored_at)`).
- **User detail "Linked accounts" table** — a merged account's `/users/:id`
  page lists its sibling aliases (`UserSummary.linkedAccounts`) in the same
  table layout as the Person page, with the canonical-person link in the table
  footer.
- **Members page activity section + alias search** — the Members page gains an
  activity feed (same filters as other pages); `WorkspaceMember.aliasSearch`
  lets a merged person be found by _any_ linked account's name/username/email,
  not just the primary. Page size set to 30 rows.

### Changed

- **Repository detail contributors are person-aware** — the "Contributors —
  last 30 days" list and the contributor stat card key on the merged entity
  (`RepoContributorEntity`); a person's aliases that both touched the repo
  collapse into one row with the `×N` pill.
- **Project detail contributors are person-aware** — the contributor stat card
  changed from 7-day to **30-day** and is now an entity-distinct count; the
  "Contributors — last 30 days" table is entity-keyed; the repositories table's
  "Contributors — 30d" column is an entity-distinct count (a merged person
  counts once even if two aliases touched the repo).
- **`CACHE_VERSION` 14 → 20** — persisted-store shape changes across the work
  (`WorkspaceMember` entity shape + `aliasSearch`, `TopContributorEntity`,
  `PersonSummary.attachedUsers.lastActiveAt`, `UserSummary.linkedAccounts`,
  `RepoActivity` / `ProjectStats` entity-keyed contributors). The boot-time
  bust wipes stale `bbstat-*` localStorage on each user's next load.

### Removed

- **Dead contributor types** — `RepoContributor`, `TopContributorWithSparkline`,
  and `TopContributor` were orphaned once the repo/project lists moved to the
  entity-keyed shapes; removed from `stats-store.ts` + `client.ts`.

### Operator notes — deploy runbook (1.1.0 → 1.2.0)

Prod runs the containerized stack from `compose.yaml` (no override) behind the
deployer's reverse proxy; Postgres + Redis are externally managed. The backend
image is distroless with a `node` ENTRYPOINT — pass `dist/<script>.js`
directly to `docker compose run`, **never** prefix with `node`.

1. **Build + ship images** (build host):
   ```bash
   BACKEND_IMAGE=bbstat-backend:v1.2.0 FRONTEND_IMAGE=bbstat-frontend:v1.2.0 make build-images
   docker save -o bbstat-v1.2.0.tar bbstat-backend:v1.2.0 bbstat-frontend:v1.2.0
   scp bbstat-v1.2.0.tar compose.yaml prod:/opt/bbstat/
   ```
   The frontend image bakes `CACHE_VERSION=20` + the new components; the backend
   image carries the person-aware queries + `/api/admin/people` endpoints.
2. **Load images** (prod):
   ```bash
   docker load -i bbstat-v1.2.0.tar
   export BACKEND_IMAGE=bbstat-backend:v1.2.0 FRONTEND_IMAGE=bbstat-frontend:v1.2.0
   ```
3. **Roll out** — the one-shot `migrate` service runs first and gates backend /
   sync via `depends_on: service_completed_successfully`:
   ```bash
   docker compose -f compose.yaml up -d
   docker compose -f compose.yaml logs migrate   # confirm migrations applied
   ```
   This applies **V1_4** (`people`, `users.person_id` + `is_primary_for_person`,
   `person_score`, the `leaderboard_entries` view, the partial-unique index, and
   the primary-requires-person CHECK) if it wasn't already on this database. The
   view DDL ships inside Drizzle `0003_cuddly_network.sql`, so no manual
   `CREATE VIEW` step is needed.
4. **Rebuild rollups** — **required**. The 1.1.0 merge-exclusion fix
   (`commit_daily` excludes merges) was never force-rebuilt in prod, so the
   on-disk rollup still carries merge-inflated counts that every person-aware
   read would inherit:
   ```bash
   docker compose -f compose.yaml run --rm backend dist/scripts/rebuild-rollups.js
   ```
5. **Recompute scores** (user + person passes; person is a no-op until the
   first merge exists, but harmless):
   ```bash
   docker compose -f compose.yaml run --rm backend dist/scripts/recompute-user-scores.js
   ```
6. **Clear the stale user-summary cache** — `UserSummary` gained
   `linkedAccounts`, and the rollup rebuild changed cached aggregates. The
   managed Redis is shared with other projects, so **do not `FLUSHDB`** —
   delete only this app's user-summary keys by prefix (this also leaves the
   `bbstat:bitbucket-auth-state` flag intact, which is meant to survive
   deploys):
   ```bash
   redis-cli -u "$REDIS_URL" --scan --pattern 'bbstat:user-summary:*' \
     | xargs -r redis-cli -u "$REDIS_URL" UNLINK
   ```
   `--scan` is non-blocking (SCAN under the hood); `xargs -r` is a no-op when
   there are zero matches. Order matters: rebuild → recompute → clear, so
   reads repopulate from fresh data.
7. **Browser cache** — automatic. The `CACHE_VERSION=20` boot-bust wipes stale
   `bbstat-*` localStorage on each user's next page load; no manual action.
8. **Smoke** — load the dashboard; confirm Members + Top Contributors render,
   counts look merge-excluded and sane, and the browser console is clean.

**Rollback:** redeploy the `v1.1.x` images and re-run steps 4–6. The schema is
forward-compatible (no destructive change), so no down-migration is needed; a
person layer with zero merges is behaviorally identical to 1.1.x.

## [1.1.0] — 2026-05-24

ShipShow Score / leaderboard, member persona categorization, and a handful of
UI + operational polish landed on top of the v1.0 baseline. No breaking schema
changes for downstream consumers; the additive `bbstat.user_score` table and
the `commit_daily.merge_commit_count` split are picked up automatically by the
shipped migrations.

### Added

- **ShipShow Score engine** (`apps/backend/src/scoring/`) — pure-function scoring
  with split-log per-commit math (`ln(1+adds) + α·ln(1+dels)`, α=1.2),
  p95-capped churn floor (FLOOR=500), 30-day half-life decay for the trending
  score, un-decayed per-window volumes (7d / 30d / 90d / 365d / all-time), and
  90-day consistency from active-day gap CV. Fully unit-tested. See
  [`docs/scoring.md`](docs/scoring.md).
- **`user_score` rollup table** + `user_badge` and `user_badge_tier` enums.
  Recomputed at the tail of every commits-sync tick; sub-second at the live
  corpus (~110 devs, ~52k eligible commits).
- **Six personality badges** — `fresh_meat`, `deep_diver`, `ai_alex`,
  `cleanup_crew`, `batch_betty`, `steady_eddie` (catch-all). Cascade is
  exhaustive for active devs; only dormant rows go badge-less. Steady Eddie
  is tiered (bronze / silver / gold) by momentum rank within cohort —
  recency-aware where consistency-based tiering had been blind to it.
- **Members page = leaderboard** — default sort `scoreTrending` desc; new
  Momentum, 7d / 30d / 90d / 365d / all-time volume, and Badge columns sit on
  the right of the vertical separator. `BadgeIcon` component with tier-tinted
  circular backgrounds for Steady Eddie.
- **Methodology modal** (`apps/frontend/src/components/MethodologyModal.vue`)
  — KaTeX-rendered formulas reachable from the Members page header so the
  scoring math is legible to non-engineers.
- **Member persona surface** — three tiers visible on the Members page:
  active workspace members (`is_workspace_member && !is_dormant`), dormant
  workspace members (`is_workspace_member && is_dormant` — row grayed),
  ex-members / external contributors (`!is_workspace_member` — email line
  tinted red, auto-created during commit ingest when BB attributed a commit
  to a UUID we hadn't seen in member sync; flag flips back the next time
  they reappear in `/workspaces/{ws}/members`).
- **BitBucket token-expiry surface** — edge-triggered auth-state hook on the
  BB client flips a Redis `bbstat:bitbucket-auth-state` flag on 401/403 and
  clears it on the next 2xx. Dashboard `!!` and the global footer's
  last-sync label turn red with an explanatory tooltip while the flag is
  set; `/api/bitbucket/auth-state` lets the SPA read the current flag at
  boot. Fresh sync processes hydrate initial state from Redis so a stale
  flag from before a restart doesn't dedupe the first post-rotation 2xx.
- **`POST /api/admin/scores/recompute`** + `make recompute-user-scores` — manual
  rollup trigger for post-tuning backfills and the post-deploy smoke step.
- **`commit_daily.merge_commit_count`** column — merge commits now have their
  own tally so repo-level "all commits" reads stay correct without inflating
  user-level metrics from merge churn.
- **`docs/README.md`** — index across all docs so new readers have a single
  jumping-off point.

### Changed

- **`commit_daily.commit_count / additions / deletions` exclude merges**
  (`a67b5f5`). Previous rollups silently double-counted merge churn into
  user-level totals; merge contributions now flow only into the new
  `merge_commit_count` column. Existing rollups are recomputed automatically
  on the next commit-sync tick; run `make rebuild-rollups` to force-rebuild
  immediately.
- **`scoring.md` rewritten as a landed reference** (was the design plan).
  Algorithm and calibration content preserved; phase plan removed; operating
  notes (`recomputeUserScores` automatic vs manual, persona surface, deploy
  reminder) added. `docs/members.md` cross-links to it.
- **ROADMAP renumbered.** Webhook trigger moved from Phase 5 to Phase 7 since
  it shares a public-URL dependency with the planned auth flow. New phases
  added: Phase 5 — User alias merge (planning TBD); Phase 6 — Org-email auth
  and BitBucket account linking (planning TBD); Phase 8 — Admin dashboard
  (planning TBD). Phase 4.5 (ShipShow Score) marked landed inline.
- **`VITE_CONTACT_EMAIL` plumbed into the frontend Docker build** (`239bffa`).
  The footer's `mailto:` placeholder now resolves correctly in the
  containerized image; previously it was empty in any non-host build.

### Fixed

- **Stale store-test fixtures** (`3383a46`) — fixtures in
  `apps/frontend/tests/` were out of sync with the live `WorkspaceMember`
  shape (missing `scoreTrending`, badge fields). Repaired the `typecheck`
  script while we were there.
- **Steady Eddie tiers no longer use consistency** (`d66dc89`). A dev who had
  been prolific 60 days ago but had gone silent in week 12 kept a high
  consistency score (the 90d window has no recency weighting) and ranked
  gold; momentum (which has 30d-half-life decay) naturally demotes them. The
  2026-05-22 smoke caught it; the tier classifier now ranks within cohort by
  momentum.
- **Exhaustive badge cascade** (`087fe21`) — earlier cascades surfaced 81% of
  the corpus as Fresh Meat (mostly dormant veterans being mistagged) or left
  the org's top-momentum dev badge-less because their consistency was one
  basis point below the Steady Eddie threshold. Steady Eddie is now a true
  catch-all for active devs; only dormant rows have no badge. Non-workspace
  styling decoupled from dormant styling so the UI no longer conflates "left
  the workspace" with "quiet lately."

### Removed

- **Dormant leaderboard cache code** (`be739f9`) — the Redis leaderboard
  cache layer drafted during scoring Phase 3 was never wired up. The live
  corpus reads the rollup table directly in sub-millisecond time, so the
  cache hop was dead weight. `bbstat:leaderboard:*` keys are not produced
  by any current code path.

## [1.0.0] — 2026-05-21

First tagged release — the full ingest-to-dashboard pipeline through the
Phase 4 follow-ups (per-developer scoring / leaderboard arrives in 1.1.0).
Everything below is net-new; there is no prior release to diff against.

### Added

- **BitBucket ingest pipeline** — HTTP client with Basic auth
  (`<email>:<api-token>`), exponential-backoff retries, 429-aware pacing off
  `Retry-After`, and a self-counted call-budget ledger. Per-repo delta commit
  pull keyed on `sync_state.last_seen_sha` so idle repos cost a single call;
  pull-request ingest on the same cursor pattern; per-commit diff stats
  (additions / deletions) on a newest-first global pickup. A self-queueing
  deepen-backfill walks history backwards within the remaining budget, and
  adaptive pacing doubles on every 429 to ride under BB Cloud's burst
  limiter. Author resolution joins `commits.author_user_id` by BitBucket
  UUID; unmatched commits stay anonymous, with a standalone
  anonymous-commit sweep runner to re-attribute them once the author is known.
- **Curated tracked set** — only repos in the `repositories` table are
  ingested (untracked repos cost zero API calls). Seeded from
  `tracked-repos.yaml` (hot-reloaded on every discovery sync) and grown via
  `POST /api/admin/repositories`; archive / unarchive / hard-delete admin
  endpoints manage the set, archive keeping history while stopping sync.
- **Rollups + Redis user-summary cache** — a single
  `commit_daily(day, repository_id, author_user_id, commit_count, additions,
deletions)` base table backs every per-user / per-repo / per-project
  aggregation as a SQL roll-up (no parallel summary tables). The expensive
  per-user summary is cached in Redis (`bbstat:user-summary:{id}`, 1h TTL),
  recomputed-then-invalidated after each sync so a read never serves a torn
  value. `make rebuild-rollups` repairs drift on demand.
- **Dashboard + detail pages** — overview stat cards, a Top Contributors
  panel with a 7d / 30d window toggle and per-developer 30-day sparklines,
  a unified commit + PR activity feed, and a 365-day contribution heatmap.
  Standalone `/projects`, `/repositories`, `/members`, and `/activity` index
  pages (search / sort / filter / paginate) plus `/users/:id`,
  `/projects/:key`, and `/repositories/:ws/:slug` detail pages, all reachable
  from the dashboard. Project↔repo filter interlock (pick a repo and its
  project fills in; pick a project and the repo list trims). The Members page
  carries an activity-status donut + a Lorenz/Gini commit-concentration curve;
  git-author email is captured at ingest with a retroactive admin backfill.
  Sync-health is surfaced as a per-repo state icon across every list and
  detail page.
- **Live updates** — Server-Sent Events push sync-tick / repository-change
  events to open tabs, with a polling fallback when SSE is unavailable. Pinia
  stores persist across reloads as an offline-first read cache, guarded by a
  `CACHE_VERSION` boot-bust that wipes stale `bbstat-*` localStorage whenever
  a persisted-store shape changes.
- **Containerized deploy** — `compose.yaml` production base (migrate / backend
  / sync / frontend) + `compose.override.yaml` dev overlay (postgres / redis /
  Traefik). Multi-stage builds produce a distroless `node` backend and an
  nginx-unprivileged frontend; one backend image serves all three roles via
  `command:` overrides, with the migrate one-shot gating backend / sync through
  `depends_on: service_completed_successfully`. Production tarball distribution
  (`docker save` → `scp` → `docker load`), BitBucket credentials interpolated
  from shell env (off-disk secrets), and every table under a dedicated
  `bbstat` Postgres schema namespace.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phase-by-phase landed summary
(Phases 0–4 + follow-ups) and git history prior to `v1.0.0` for the full
commit set.

[unreleased]: https://github.com/tigerit/bbstat/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/tigerit/bbstat/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/tigerit/bbstat/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/tigerit/bbstat/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tigerit/bbstat/releases/tag/v1.0.0
