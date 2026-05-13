# Sync & data ingest

Operator + reader notes for the full sync pipeline — commit ingest (Phase 2),
the `commit_daily` rollup + Redis user-summary cache (Phase 3), and the
Phase 4 additions: per-commit diff stats, PR ingest, and the unified
`/api/activity` feed. Architectural rationale lives in `CLAUDE.md`; this doc
is the operational reference — what each knob does, what the cursors
guarantee, when the rollup drifts, and how to read the logs when something
looks off.

## Four sync entry points

All four converge on `runSync()`-style functions in
`apps/backend/src/sync/runner.ts` and share the same dedupe / idempotency /
store contracts:

| Function              | Cron default   | What it does                                                                 |
| --------------------- | -------------- | ---------------------------------------------------------------------------- |
| `runMembersSync`      | `*/10 * * * *` | Workspace members → `users`                                                  |
| `runReposSync`        | `*/5 * * * *`  | Curated tracked-repo bootstrap → `repositories` (incl. `diff_stats_enabled`) |
| `runCommitsSync`      | `*/15 * * * *` | Per-repo commit delta pull, plus opt-in `/diffstat/:sha` for new commits     |
| `runPullRequestsSync` | `*/30 * * * *` | Per-repo PR delta pull across all four BB states                             |

`make dev-sync` runs the cron host. The HTTPS API (`make dev-backend`) does
**not** schedule any cron — they're deliberately separate processes, so
stopping the API server doesn't stop the sync. Triggering work manually goes
through the admin endpoints (below); the same runner functions are reused.

## Curated tracked set

The set of repos `runReposSync` / `runCommitsSync` / `runPullRequestsSync`
operate on is sourced from `tracked-repos.yaml` at the repo root (gitignored
— copy from `tracked-repos.yaml.example` on a fresh clone). The file holds
one top-level `repos:` list whose entries are either a plain
`"<workspace>/<slug>"` string (default — diff stats off) or an object
`{ name: "<workspace>/<slug>", diffStats: true }` to opt that repo into the
Phase 4 per-commit diff-stat ingest. Each entry is upserted into
`repositories` + `sync_state` via `bootstrapTrackedRepositories`, idempotent
across runs; the `diff_stats_enabled` column is written through on insert
and **updated** on subsequent runs when the YAML value diverges (so flipping
the flag in YAML re-applies at the next discovery tick). The
`BootstrapReposResult.diffStatsToggled` counter reports how many rows
changed per run.

The file is read on backend startup (one-time fail-loud parse check) and
re-read on every `runReposSync` / `runDiscoverySync` invocation, so YAML edits
land at the next sync without a restart. A missing file at the default path
is a no-op; an explicit `SEED_REPO_FILE_PATH` that doesn't exist fails loud
at startup. Malformed YAML throws — at boot if bad on startup, otherwise as
the sync's error path (500 on `POST /sync/discover`, error log under cron).

Removal isn't symmetric: deleting a YAML entry stops the repo being
re-bootstrapped, but the already-tracked row stays in `repositories` and
keeps getting synced. Soft-delete via a `tracked` column is on the Phase 5
roadmap; for now the workaround is a manual DELETE against `repositories`
(cascades to `sync_state` and `commits`).

## Commit-sync modes

Each tracked repo has one row in `sync_state` with a single cursor:
`last_seen_sha`. A per-repo run picks one of three modes:

- **cold** — cursor is `NULL`. Walks newest-first, capped by
  `COMMITS_BACKFILL_MAX_PAGES` (default 5 pages × 100 = 500 commits) and/or
  `COMMITS_BACKFILL_SINCE` (an ISO date). Whichever fires first wins.
- **delta** — cursor is set. Walks newest-first, stops at the matching SHA.
  An idle repo costs exactly 1 API call.
- **no-state** — no `sync_state` row. Logged and skipped. Shouldn't happen in
  practice — `addTrackedRepository` creates the row in the same transaction
  as the repo.

`firstRunMaxPages` is **cold-only**. If a cursor gets orphaned by a force
push, the delta walk finishes the entire history (slow but correct).

## Cursor guarantees

- **Idempotent.** `commits` has a UNIQUE index on `(repository_id, sha)`;
  bulk insert uses `ON CONFLICT DO NOTHING`. Running the same sync twice
  never duplicates.
- **No-op preserves cursor.** A delta run that finds nothing new (the cursor
  matched the very first commit BB returned) leaves `last_seen_sha` untouched.
  Response field `newCursor: null` signals "wrote nothing this call" — the
  actual DB cursor is unchanged.
- **Race-tolerant.** Concurrent ticks (manual + cron) on the same repo both
  succeed. ON CONFLICT + stop-on-known-sha cause them to converge on the
  same end state. `total_commits_synced` increments via SQL `col + n` so
  concurrent ticks don't lose count to read-modify-write.
- **Author fallback.** A commit's BitBucket UUID either matches a row in
  `users` (sets `author_user_id`) or it doesn't — both anonymous commits
  (no `author.user` in the BB payload) and unmatched UUIDs land as
  `author_user_id = NULL`. The Top Contributors panel inner-joins `users`,
  so those commits don't surface there but are still in `totalCommits`.

## Budget gate

BB Cloud's per-identity rate limit is ~1000 calls/hour, and the API
**doesn't return `X-RateLimit-*` headers on success** (see
`memory/bitbucket_rate_limit_headers.md`). So `BitbucketClient` keeps its
own sliding-window ledger of every fetch attempt — including retries, which
cost on BB's side too.

Each commit-sync tick is a worker pool:

1. Up to `COMMIT_SYNC_CONCURRENCY` (default 3) repos in flight at once.
2. Before claiming the next repo, each worker re-checks
   `getBudgetRemaining()`. If it falls below `COMMIT_SYNC_BUDGET_THRESHOLD`
   (default 20), the worker stops scheduling new work.
3. Unclaimed repos come back as `deferred[]` for the next tick;
   `stoppedEarly: true` flags this happened.
4. Errors in one repo never abort siblings — recorded per-repo in `errors[]`.

The default budget (800) leaves a 200-call buffer below BB's documented cap;
the default threshold (20) is sized above the worst-case per-repo cost
(`firstRunMaxPages × concurrency` = 15 + slack).

## Rollups

The dashboard reads from `commit_daily`, a per-day per-(repo, user) rollup
of the commit log. UTC-aligned `day` column; `UNIQUE NULLS NOT DISTINCT
(day, repository_id, author_user_id)` collapses anonymous commits to one
row per (day, repo). All commit-aggregation endpoints (`/overview`,
`/top-contributors`, `/users/:id/summary`, `/projects/:key`,
`/repositories`, `/repositories/:ws/:slug/activity`) read here instead of
scanning `commits`, keeping latency flat as the commit log grows.

**How it stays current.** After each successful per-repo commit sync with
`inserted > 0`, `withRollupRecompute` (`apps/backend/src/dashboard/rollup-hook.ts`)
re-aggregates `commit_daily` over the touched day range and DELs the
Redis user-summary cache for users whose commits just landed. Recompute
runs **before** invalidation so concurrent reads always refill cache from
fresh data. Both side effects are independently failure-isolated — a
rollup or cache error never poisons the commit-sync result.

**When it can drift.** The migration backfill (`V1_3__commit_daily.sql`)
uses `ON CONFLICT DO NOTHING` so re-applying it is safe but doesn't fix
stale rows. So: commits that land through any code path **other than** a
`withRollupRecompute`-wrapped sync (e.g. raw SQL inserts, restoring from
a backup, applying the migration after sync runs had already happened
without the hook) leave the rollup behind by exactly those commits. The
sync hook keeps it current going forward.

**Repairing drift.** `make rebuild-rollups` runs an unscoped UPSERT over
the whole `commits` table — same aggregate shape as the migration
backfill but `ON CONFLICT DO UPDATE`, so it overwrites stale buckets
instead of skipping them. Shipped as a script rather than an HTTP admin
endpoint because the deployment has no auth yet; the underlying
`RollupStore.rebuildAll()` is the seam to lift into an authenticated
admin route later. The rebuild does NOT prune orphan rollup rows whose
backing commits were `DELETE`d out-of-band; the repo FK cascade handles
repo removals, and manual commit deletion is the only remaining edge.

## Diff-stat ingest (opt-in, Phase 4)

Per-commit `additions` / `deletions` aren't populated by the commit walk
itself — that would mean one `/diffstat/:sha` call per commit ingested
across the entire backfill. Instead, diff-stat ingest is a separate
opt-in step inside the commit tick that runs only for repos with
`repositories.diff_stats_enabled = true` and only for commits whose
`commits.diff_stats_synced_at` is still NULL. A partial index
(`commits_pending_diff_stats_idx (repository_id) WHERE
diff_stats_synced_at IS NULL`) keeps the pickup query cheap as the commit
log grows.

How it runs:

- `syncRepositoryCommits` invokes `syncRepositoryDiffStats` after
  `markSyncSuccess` lands, so the cursor and the new commit rows are
  durable before any diff call happens. Failures in this step never
  poison the commit-sync result: the rows already inserted stay
  inserted, the cursor stays advanced, and any commits with
  `diff_stats_synced_at IS NULL` get retried on the next tick.
- Per tick: up to `DIFF_STATS_MAX_PER_REPO_PER_TICK` (default 50)
  pending commits per repo, ordered newest-authored-first. Before each
  fetch, `getBudgetRemaining()` is checked against
  `DIFF_STATS_BUDGET_THRESHOLD` (default 10); if the BB-call budget
  falls below the threshold the worker stops and remaining commits roll
  over to the next tick.
- Per commit: one `/diffstat/:sha` call, sum across files (treating
  NULL `lines_added/lines_removed` as zero for binary diffs), UPDATE
  `commits` with the totals and stamp `diff_stats_synced_at = now()`.
  A per-commit fetch error logs and continues — that one row stays
  NULL and gets retried; siblings aren't affected.

Backfilled history (cold-mode commits inserted during the first run for
a repo) is implicitly skipped per the roadmap — those commits ALSO have
`diff_stats_synced_at IS NULL` and will be picked up, so if you toggle
a repo into diff*stats \_after* its cold-mode backfill, expect a one-time
spend of up to `pending_commits / DIFF_STATS_MAX_PER_REPO_PER_TICK`
ticks to drain. The cap keeps that drain bounded.

Rollup interaction: `commit_daily` aggregates additions / deletions from
`commits`. The rollup hook in `dashboard/rollup-hook.ts` recomputes the
`commit_daily` day window whenever either `inserted > 0` OR
`diffStatsUpdated > 0`, passing the union of `insertedRange` and
`diffStatsRange` to `recomputeCommitDailyForRepo`. Cache invalidation
widens to the same range.

## Pull-request ingest (Phase 4)

PR ingest runs on its own 30-minute cron (`SYNC_PRS_CRON`) — PRs mutate
slower than commits, and a tighter cadence would waste budget. The
mechanics mirror the commit pipeline:

- BB endpoint: `/repositories/{ws}/{slug}/pullrequests?state=OPEN&state=
MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on`. The four
  `state=` filters live inline in the request path (the client's
  `RequestOptions.query` map only allows one value per key); URL
  semantics preserve them through `paginate()`'s `pagelen` + `fields`
  appends.
- Per-repo cursor lives on `sync_state` (separate columns from the
  commit-pull cursor — both pipelines write disjoint fields, so they
  don't stomp on each other):
  - `last_pr_updated_at` — the most-recent `updated_on` we've ingested.
    Strict-less-than is the stop condition for delta walks; PRs in the
    same second as the cursor flow through the UPSERT path idempotently
    rather than relying on BB's per-second ordering being stable.
  - `last_pr_id` — stored alongside for ops debugging. It is **not**
    used in the stop predicate.
  - `pr_last_synced_at` — observational; when the PR sync last ran for
    this repo.
  - `pr_total_synced` — running count, incremented via atomic
    `col + n` so concurrent ticks (cron + manual) can't lose count.
- Modes: cold (`last_pr_updated_at IS NULL`) caps at
  `PR_BACKFILL_MAX_PAGES × 100` PRs. Delta walks newest-first and stops
  at `updated_on < cursor`.
- UPSERT semantics: `INSERT ... ON CONFLICT (repository_id,
bitbucket_pr_id) DO UPDATE` — PR state mutates over a PR's lifetime
  (OPEN → MERGED/DECLINED, comment / task count churn), so we refresh
  the mutable columns rather than skipping. Inserted-vs-updated counts
  come from a pre-flight SELECT and are advisory — race-tolerant by
  intent.
- Tick orchestrator (`runPullRequestsTick`) mirrors `runCommitsTick`:
  bounded concurrency (`PR_SYNC_CONCURRENCY`, default 3), budget gate
  (`PR_SYNC_BUDGET_THRESHOLD`, default 20), per-repo error isolation
  (one repo's transient 500 doesn't starve the rest).
- PR sync **does not** persist a status enum or last-error string on
  `sync_state`. PR errors land in the tick-result `errors[]` array and
  structured logs only — matching how the commit tick already reports
  per-repo failures.

## Configuration

All knobs have safe defaults — a fresh clone runs the cron without
overrides. Set in `.env` at the repo root.

| Env var                            | Default        | Notes                                                                             |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `BITBUCKET_HOURLY_CALL_BUDGET`     | `800`          | Soft cap on outbound BB calls per rolling hour, shared across every sync surface. |
| `SYNC_COMMITS_CRON`                | `*/15 * * * *` | When the commit cron fires.                                                       |
| `COMMITS_BACKFILL_MAX_PAGES`       | `5`            | Cold-mode commit cap: stop after N pages of 100.                                  |
| `COMMITS_BACKFILL_SINCE`           | _(empty)_      | Cold-mode commit cap: ISO 8601 date. Empty = no date cap.                         |
| `COMMIT_SYNC_CONCURRENCY`          | `3`            | Max repos in flight per commit tick.                                              |
| `COMMIT_SYNC_BUDGET_THRESHOLD`     | `20`           | Defer next repo when budget falls below this.                                     |
| `DIFF_STATS_MAX_PER_REPO_PER_TICK` | `50`           | Phase 4: per-repo pending-commit cap for the diff-stat worker.                    |
| `DIFF_STATS_BUDGET_THRESHOLD`      | `10`           | Phase 4: per-repo budget gate inside the diff-stat worker loop.                   |
| `SYNC_PRS_CRON`                    | `*/30 * * * *` | Phase 4: when the PR cron fires. PR data mutates slower than commits.             |
| `PR_BACKFILL_MAX_PAGES`            | `5`            | Phase 4: cold-mode PR cap (pages × 100).                                          |
| `PR_SYNC_CONCURRENCY`              | `3`            | Phase 4: max repos in flight per PR tick.                                         |
| `PR_SYNC_BUDGET_THRESHOLD`         | `20`           | Phase 4: defer next repo when budget falls below this.                            |

The members + repos crons (`SYNC_MEMBERS_CRON`, `SYNC_REPOS_CRON`) are also
overridable, but their defaults are intentionally tight for dev visibility —
lengthen in production if you want.

## Endpoints

### Admin (open by design — no auth, see `CLAUDE.md`)

| Endpoint                                                          | Purpose                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /api/admin/sync/discover`                                   | Members + curated repo bootstrap. Result includes `diffStatsToggled`. |
| `POST /api/admin/sync/commits`                                    | Full commit tick. Returns `CommitsSyncResult` (summary + per-repo).   |
| `POST /api/admin/sync/repositories/:workspace/:slug/commits`      | Force a delta commit pull for one repo. 404 if not tracked.           |
| `POST /api/admin/sync/pullrequests`                               | Full PR tick. Returns `PrsSyncResult` (summary + per-repo).           |
| `POST /api/admin/sync/repositories/:workspace/:slug/pullrequests` | Force a delta PR pull for one repo. 404 if not tracked.               |
| `POST /api/admin/repositories`                                    | Add a repo to the tracked set. Body: `{ workspace, slug }`.           |

### Dashboard read side

| Endpoint                                                     | Returns                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/stats/overview`                                    | `{ users, repositories, projects, totalCommits, commitsLast7Days }`                                                             |
| `GET /api/stats/repositories/:workspace/:slug/latest-commit` | Newest commit + author, or 404 if the repo is untracked / has no ingested commits.                                              |
| `GET /api/stats/top-contributors?window=7d\|30d`             | Top 10 developers by commit count over the trailing window. Each row also carries a 30-day `last30Days` sparkline series.       |
| `GET /api/stats/users/:userId/summary`                       | Per-user summary: 7d/30d/all-time totals, 30-day daily sparkline, top 5 repos in 30d (each with project key).                   |
| `GET /api/stats/projects/:projectKey`                        | Project rollup: totals, 12-week sparkline, top 10 contributors, per-repo summary list.                                          |
| `GET /api/stats/repositories/:workspace/:slug/activity`      | Repo activity: 30-day daily sparkline + 30-day contributor list. (`recentCommits` dropped — see `/api/activity`.)               |
| `GET /api/stats/repositories`                                | All tracked repositories with `project`, `commits30d`, `contributors30d`, and `lastCommitAt`.                                   |
| `GET /api/activity`                                          | Phase 4 unified feed of commits + PRs, newest-first. See "Activity feed" below for filters, pagination, and the response shape. |

All `/api/stats/*` endpoints read from `commit_daily` joined to
`repositories` / `users` and return 404 when a specific target entity doesn't
exist. The repository-list endpoint drives the dashboard's Projects panel
(derived client-side by grouping on `project`) and Repositories panel.

### Activity feed (`GET /api/activity`)

Unified, time-ordered stream of commits + pull-requests. Lives at `/api`
(not `/api/stats`) because it has a different shape than the rest of the
dashboard endpoints — bypasses Redis per CLAUDE.md's "Redis is user-summary
only" rule and reads straight from Postgres via a `UNION ALL` over
`commits` + `pull_requests` with each branch's filter predicates pushed in.

Query params (all optional):

| Param     | Type   | Notes                                                                                  |
| --------- | ------ | -------------------------------------------------------------------------------------- |
| `actor`   | int    | Filter to a single `author_user_id`. Anonymous-author rows never match.                |
| `repo`    | string | `"<workspace>/<slug>"`. Regex-validated; malformed values 400 with `invalid_query`.    |
| `project` | string | Project key. Matches `repositories.project` exactly.                                   |
| `before`  | ISO    | Strict-less-than cursor; the client passes the last entry's `occurredAt` back to page. |
| `limit`   | int    | 1–200, default 50. The frontend paginates at 50 per page.                              |

Response is a discriminated array on `kind`:

```jsonc
[
  { "kind": "commit", "sha": "...", "message": "...", "additions": 12, "deletions": 3,
    "repository": { "workspace": "...", "slug": "...", "fullName": "..." },
    "author": { "userId": 1, "displayName": "Alice", "bitbucketUuid": "{...}" } | null,
    "occurredAt": "..." }, // commits.authored_at

  { "kind": "pr", "prId": 42, "title": "...", "state": "OPEN|MERGED|DECLINED|SUPERSEDED",
    "sourceBranch": "...", "destinationBranch": "...",
    "repository": { ... }, "author": ... | null,
    "occurredAt": "..." }  // pull_requests.bitbucket_updated_at (so state changes resurface)
]
```

Ordering: `ORDER BY occurred_at DESC, kind, id DESC`. Distinct id namespaces
between branches make the tiebreak deterministic without a global sequence.
The PR `occurredAt = updated_on` is intentional — a PR's row resurfaces in
the feed each time its state transitions or comments churn, matching BB's
own activity-timeline behavior. A single PR can appear at multiple positions
across pages over its lifetime.

### Caching

`GET /api/stats/users/:userId/summary` is read-through against a Redis cache
(`bbstat:user-summary:{id}`, 1h TTL). The sync hook in `rollup-hook.ts` DELs
the same key the moment new commits land for that user, so the TTL is only a
backstop for inactive users — fresh data is immediate after a sync. Project
and repo endpoints read from the rollup table directly per CLAUDE.md's
"Redis is user-summary only" rule.

## Reading sync logs

`runCommitsSync` emits structured Pino lines:

```
"commit sync start"     { trigger, workspace, repoCount }
"commit sync complete"  { trigger, attempted, deferred, errors,
                          totalCommitsInserted, budgetRemainingAtEnd,
                          stoppedEarly, startedAt, finishedAt }
```

Per-repo, from `syncRepositoryCommits`:

```
"commit sync complete"  { repositoryId, fullName, mode, fetched, inserted,
                          hitKnownSha, hitPageCap, hitDateCap,
                          diffStatsUpdated, diffStatsFailed }
```

Per-repo, from `syncRepositoryDiffStats` (Phase 4):

```
"diff-stats sync complete"  { repositoryId, fullName, updated, failed,
                              hitBudgetGate, diffStatsRange }
```

`runPullRequestsSync` emits an analogous start / complete pair, and per-repo
`syncRepositoryPullRequests` logs:

```
"PR sync complete"  { repositoryId, fullName, mode, fetched, inserted,
                      updated, hitKnownCursor, hitPageCap }
```

When in doubt, query `sync_state` directly:

```sql
SELECT r.full_name,
       s.last_seen_sha,
       s.last_sync_status,
       s.last_sync_error,
       s.total_commits_synced,
       s.last_synced_at,
       s.last_pr_updated_at,
       s.last_pr_id,
       s.pr_last_synced_at,
       s.pr_total_synced
FROM sync_state s JOIN repositories r ON r.id = s.repository_id
ORDER BY s.last_synced_at DESC NULLS LAST;
```

To eyeball pending diff stats for a repo:

```sql
SELECT r.full_name,
       count(*) FILTER (WHERE c.diff_stats_synced_at IS NULL) AS pending,
       count(*) AS total
FROM repositories r
JOIN commits c ON c.repository_id = r.id
WHERE r.diff_stats_enabled
GROUP BY r.full_name
ORDER BY pending DESC;
```
