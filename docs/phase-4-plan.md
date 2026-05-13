# Phase 4 — Code-change volume + activity feed

Plan-of-record for Phase 4. Roadmap line lives in
[`ROADMAP.md`](ROADMAP.md#phase-4--code-change-volume--activity-feed); this
doc breaks the phase into landable tasks and records the design calls already
made. Update the **Status** column as commits land; when the phase wraps,
fold the operator-facing pieces into [`sync.md`](sync.md) and mark the
roadmap entry `✅ Landed`.

## Scope summary

Four work streams, ordered:

| ID  | Stream                       | Est.   | Status      |
| --- | ---------------------------- | ------ | ----------- |
| T21 | Diff stats per new commit    | ~1.5 d | Not started |
| T22 | Pull-request ingest          | ~1.5 d | Not started |
| T23 | `/api/activity` unified feed | ~0.5 d | Not started |
| T24 | Frontend sparklines + feed   | ~1.5 d | Not started |

Total: 5 days of focused work, fitting the roadmap's 3–4 day budget with
slack for the frontend polish.

## Decisions locked in (no need to revisit)

1. **Diff-stat opt-in is per-repo via `tracked-repos.yaml`** — each entry is
   either a `"<ws>/<slug>"` string (legacy, `diffStats = false`) or an
   object `{ name: "<ws>/<slug>", diffStats: true }`. Hot-reloaded on every
   `runReposSync` / `runDiscoverySync`. Authoritative value lives in
   `repositories.diff_stats_enabled`.
2. **PR cursor lives on `sync_state`** — new columns `last_pr_updated_at`,
   `last_pr_id`, `pr_total_synced`. Mirrors the commit cursor model.
3. **Diff-stat resumability via a column on `commits`** —
   `commits.diff_stats_synced_at timestamptz NULL` plus a partial index
   `WHERE diff_stats_synced_at IS NULL`. NULL = "fetch pending"; non-NULL =
   "done at this time". No side table.
4. **Activity feed PR timestamp = `bitbucket_updated_at`** — state changes
   (merge, decline, comment churn) resurface the PR. A PR can appear at
   multiple positions across pages over its lifetime; that's intended.
5. **No webhook work in Phase 4** — Phase 5, gated on a public URL. See
   `memory/webhook_deferred.md`.

## T21 — Diff stats per new commit

**Goal:** populate `commits.additions` / `commits.deletions` for every
_new_ commit landing into opt-in repos. Backfilled (cold-mode) history is
skipped per the roadmap.

### Schema

- `repositories.diff_stats_enabled boolean NOT NULL DEFAULT false`.
- `commits.diff_stats_synced_at timestamptz NULL`.
- Partial index
  `commits_pending_diff_stats_idx (repository_id) WHERE diff_stats_synced_at IS NULL` —
  fast pickup query.
- Drizzle migration `0003_*` + manual mirror
  `apps/backend/schema/V1_4__repositories_diff_stats.sql`. Both updated in
  lockstep per `apps/backend/schema/README.md`.

### YAML schema extension

`apps/backend/src/sync/discovery.ts` `parseSeedRepoFile`:

```yaml
repos:
  - tigerit/boing-server # legacy form, diffStats=false
  - { name: tigerit/comm-adm, diffStats: true }
```

Zod discriminated union. `RepoSeed` gains `diffStatsEnabled: boolean`.
`bootstrapTrackedRepositories` sets the column on first insert and updates
it on `already-tracked` rows when the YAML value diverges — so toggling
the flag in YAML re-applies at the next discovery tick.

### BitBucket wrapper

New module `apps/backend/src/bitbucket/diff-stats.ts`:

- `paginateDiffStat(client, workspace, slug, sha)` over
  `/repositories/{ws}/{slug}/diffstat/{sha}`.
- Field filter: `values.lines_added,values.lines_removed,next`.
- Returns `{ additions, deletions }` summed across all files in the response.

### Sync integration

New module `apps/backend/src/sync/diff-stats.ts`:

- `syncRepositoryDiffStats(deps, repo)`:
  - Short-circuits when `repo.diffStatsEnabled === false`.
  - Picks up to `DIFF_STATS_MAX_PER_REPO_PER_TICK` (default 50) commits
    where `diff_stats_synced_at IS NULL`, ordered by `authored_at DESC`.
  - For each: budget check → fetch diffstat → `UPDATE commits SET
additions=?, deletions=?, diff_stats_synced_at=now() WHERE id=?`.
  - Stops mid-batch if `getBudgetRemaining()` falls below
    `DIFF_STATS_BUDGET_THRESHOLD` (default 10). Remaining pending commits
    get picked up on the next tick — that's the resumability guarantee.
- Wired into the commit tick: `runCommitsTick` after `syncRepositoryCommits`
  returns, invoke `syncRepositoryDiffStats(repo)` if `diffStatsEnabled`.
  Result piggybacks on `RepoCommitSyncResult` via a new
  `diffStatsUpdated: number` field.

### Rollup hook update

`commit_daily` aggregates `additions` / `deletions` from `commits`. When a
tick updates a row's diff stats but `inserted=0`, `withRollupRecompute`
currently returns early (it only triggers on inserts). Fix:

- `RepoCommitSyncResult` gains an optional `diffStatsRange: { sinceDay,
untilDay }` — the day-bucket span of commits whose diff stats just landed.
- `withRollupRecompute` re-aggregates the union of `insertedRange` and
  `diffStatsRange`. Day window is derived from the touched commit
  timestamps, scoped to the affected repo.
- Cache invalidation widens to the same range.

### Config knobs

| Env var                            | Default | Notes                                        |
| ---------------------------------- | ------- | -------------------------------------------- |
| `DIFF_STATS_MAX_PER_REPO_PER_TICK` | `50`    | Pending-commit cap per repo per commit tick. |
| `DIFF_STATS_BUDGET_THRESHOLD`      | `10`    | Per-repo budget gate inside the worker loop. |

### Tests

- `bitbucket/diff-stats.test.ts` — wrapper unit (pagination, sum across files).
- `sync/diff-stats.test.ts` — worker loop (opt-out short-circuit, budget gate
  mid-batch, idempotent re-runs, resume after partial completion).
- Extend `sync/commits-tick.test.ts` — diff-stat results flow into the tick
  result; opt-out repos don't add calls.
- Extend `dashboard/rollup-hook.test.ts` — `diffStatsRange` triggers
  recompute even when `inserted=0`.

## T22 — Pull-request ingest

### Schema

`sync_state` gains three columns:

- `last_pr_updated_at timestamptz NULL` — cursor.
- `last_pr_id integer NULL` — tie-break for same-second updates.
- `pr_total_synced integer NOT NULL DEFAULT 0`.

Drizzle migration `0004_*` + `apps/backend/schema/V1_5__sync_state_pr_cursor.sql`.

### BitBucket wrapper

`apps/backend/src/bitbucket/pull-requests.ts`:

- `paginatePullRequests(client, ws, slug, opts)` over
  `/repositories/{ws}/{slug}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on`.
  Multi-`state=` is required to get non-OPEN PRs in one call.
- Field filter: `values.id`, `values.title`, `values.state`,
  `values.source.branch.name`, `values.destination.branch.name`,
  `values.source.commit.hash`, `values.destination.commit.hash`,
  `values.author.uuid`, `values.created_on`, `values.updated_on`,
  `values.closed_on`, `values.comment_count`, `values.task_count`, `next`.

### Store

New `apps/backend/src/sync/pr-store.ts`, mirroring `CommitStore`:

- `getPrSyncState(repositoryId)` — cursor read.
- `upsertPullRequests(input[])` — UPSERT on
  `(repository_id, bitbucket_pr_id)`; **DO UPDATE** (not DO NOTHING) since
  PR state mutates. Returns `{ inserted, updated }`.
- `markPrSyncRunning / Success / Failed` — sibling of the commit-scoped
  twins. Atomic `pr_total_synced + n` increment for race tolerance.
- Drizzle-backed impl alongside the commit store.

### Sync function

`apps/backend/src/sync/pull-requests.ts` `syncRepositoryPullRequests`:

- **Cold** (cursor null): cap by `PR_BACKFILL_MAX_PAGES` (default 5).
- **Delta**: stop when `updated_on < lastSeenUpdatedAt` (strict). Tie-break
  on `(updated_on, id)` against `last_pr_id` when the timestamp matches
  exactly — BB's resolution is to the second, so collisions happen.
- Idempotent via UPSERT. Author resolution mirrors the commit path
  (uuid → users.id, NULL if unknown).
- Result type: `{ repositoryId, fullName, mode, fetched, inserted,
updated, newCursor: { updatedAt, prId } | null, hitKnownCursor, hitPageCap }`.

### Tick orchestrator

`apps/backend/src/sync/pr-tick.ts` `runPullRequestsTick` — sibling of
`runCommitsTick`. Same budget client, same shape, separate concurrency knob.

### Runner

`runPullRequestsSync(deps, trigger)` lands in `runner.ts` next to
`runCommitsSync`. Discovery (`runDiscoverySync`) stays commit-and-member
only — PRs run on their own cadence.

### Cron + admin

- New `SYNC_PRS_CRON` default `*/30 * * * *` in `apps/backend/src/config.ts`.
- Scheduled in `apps/backend/src/sync/index.ts` alongside the others.
- Admin endpoints in `routes/admin.ts`:
  - `POST /api/admin/sync/pullrequests`
  - `POST /api/admin/sync/repositories/:workspace/:slug/pullrequests`

### Config knobs

| Env var                    | Default        | Notes                                 |
| -------------------------- | -------------- | ------------------------------------- |
| `SYNC_PRS_CRON`            | `*/30 * * * *` | PRs change slower than commits.       |
| `PR_BACKFILL_MAX_PAGES`    | `5`            | Cold-mode cap.                        |
| `PR_SYNC_CONCURRENCY`      | `3`            | Repos in flight per tick.             |
| `PR_SYNC_BUDGET_THRESHOLD` | `20`           | Budget headroom needed for next repo. |

### Tests

- `bitbucket/pull-requests.test.ts` — wrapper unit.
- `sync/pull-requests.test.ts` — cold cap, delta stop, tie-break race,
  state-mutation upsert, no-state warn-and-skip (matches commit semantics).
- `sync/pr-tick.test.ts` — bounded concurrency + budget gate.
- `routes/admin.test.ts` updates — new endpoints, 404 on untracked repo.

## T23 — `/api/activity` unified feed

### Endpoint

`GET /api/activity` with optional query params:

- `actor=<userId>` — author filter (commits.author_user_id OR
  pull_requests.author_user_id).
- `repo=<workspace>/<slug>` — repository filter.
- `project=<projectKey>` — project filter.
- `before=<ISO8601>` — cursor; only entries with `occurred_at < before`.
- `limit` — default 50, max 200.

### Payload

Discriminated union by `kind`:

```ts
type ActivityEntry =
  | {
      kind: 'commit';
      sha: string;
      message: string;
      additions: number;
      deletions: number;
      repository: { workspace: string; slug: string; fullName: string };
      author: { userId: number; displayName: string; bitbucketUuid: string } | null;
      occurredAt: string; // = authored_at
    }
  | {
      kind: 'pr';
      prId: number;
      title: string;
      state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
      sourceBranch: string;
      destinationBranch: string;
      repository: { workspace: string; slug: string; fullName: string };
      author: { userId: number; displayName: string; bitbucketUuid: string } | null;
      occurredAt: string; // = bitbucket_updated_at
    };
```

### Store

`StatsStore.getActivity(filters)` — single SQL `UNION ALL` between
`commits` and `pull_requests`, each branch joined to `repositories` (and
`users` left-join). Each branch carries its own filter predicates so we
don't pull rows that get filtered out post-union. Outer `ORDER BY occurred_at
DESC, kind, id DESC LIMIT $n`. Cursor (`before`) lands in each branch's
`WHERE` clause.

Existing indexes cover the hot paths:

- `commits_author_authored_idx (author_user_id, authored_at)`
- `pull_requests_author_updated_idx (author_user_id, bitbucket_updated_at)`

### No caching

Activity is a list endpoint, not a user summary. Reads go straight to
Postgres per CLAUDE.md's "Redis is user-summary only" rule.

### Tests

- `dashboard/stats-store.test.ts` (or new `activity-store.test.ts`) —
  filter-combination matrix, mixed-kind ordering, cursor edge cases
  (no-results, exact-boundary).
- `routes/stats.test.ts` — happy path + 400 on malformed `before`.

## T24 — Frontend

### Pinia store

Rewrite `apps/frontend/src/stores/activity.ts`:

- Replace `ActivityEntry` with the unified discriminated type from T23.
- Add `loadMore({ actor?, repo?, project?, before? })` — appends to the
  current filtered list, updates the cursor.
- Key the store internally by serialized filter set so switching filters
  doesn't clobber the org-wide cache.
- `persist: true` (already present).

### Components

- **`components/ActivityFeed.vue`** — renders the timeline. Props: `actor?`,
  `repo?`, `project?`, optional `limit`. Infinite scroll via
  `IntersectionObserver` on a sentinel element. Skeleton row while loading.
  Empty state: "No activity yet for these filters."
- **`components/Sparkline.vue`** — inline SVG, ~30 lines. Props:
  `points: number[]`, `width`, `height`. No chart library.

### Dashboard sparklines

- Backend: extend `/api/stats/top-contributors` response so each row carries
  `last30Days: number[]` (length 30, oldest→newest, zeros for gaps). One
  SQL aggregation against `commit_daily` — generate a 30-day series via
  `generate_series` and `LEFT JOIN` on day → user.
- Frontend: render `Sparkline.vue` inside each Top Contributors row.

### Filter bar

Above `ActivityFeed.vue` on the Dashboard:

- Project, Repository, User dropdowns sourced from the existing
  `projectStats` / `stats` (top contributors) data already in Pinia.
- URL-synced via `useRoute` / `router.replace` so deep links work
  (`/?actor=42&repo=tigerit/boing-server`).

### Mount points

- `Dashboard.vue` — org-wide feed (no filters) + filter bar.
- `UserSummary.vue` — `<ActivityFeed :actor="userId" />` below the existing
  panels.
- `RepoActivity.vue` — `<ActivityFeed :repo="`${workspace}/${slug}`" />`.
- `ProjectStats.vue` — `<ActivityFeed :project="projectKey" />`.

### Tests

- `tests/ActivityFeed.test.ts` — mocked store, renders both kinds,
  triggers `loadMore` on sentinel intersect.
- `tests/Sparkline.test.ts` — snapshot with a few representative point sets.
- `tests/dashboard-filter-sync.test.ts` — URL ↔ filter state round-trip.

## Commit landing order

Each line is one commit, in this order:

1. `feat(schema): repositories.diff_stats_enabled + commits.diff_stats_synced_at` (T21 schema).
2. `feat(bitbucket): /diffstat/:sha endpoint wrapper` (T21 BB).
3. `feat(sync): diff-stats opt-in, worker, tick integration` (T21 main).
4. `feat(schema): sync_state PR cursor + counters` (T22 schema).
5. `feat(bitbucket): pull-requests endpoint wrapper` (T22 BB).
6. `feat(sync): PR ingest — store, sync fn, tick, runner, cron, admin` (T22 main).
7. `feat(stats): /api/activity unified commits+PRs feed` (T23).
8. `feat(top-contributors): per-user 30d sparkline array` (T24 prep).
9. `feat(frontend): ActivityFeed + Sparkline + dashboard filter bar` (T24 main).
10. `docs: phase 4 wrap — diff stats, PRs, activity feed` (final sweep).

## Out of scope

- Webhook receiver (Phase 5; needs public URL — see
  `memory/webhook_deferred.md`).
- Workspace-level repo browser / admin UI (Phase 5).
- Author email / signature attribution beyond the existing
  `author.user.uuid` → `users.id` resolution.
- Diff-stat backfill for historical commits — explicitly skipped per
  roadmap. Operators can flip a repo's `diff_stats_enabled` and the
  _next_ new commit gets stats; old commits stay at additions=0,
  deletions=0 unless we add a one-shot backfill admin route later.
