# Sync & data ingest

Operator + reader notes for the commit-ingest pipeline that lands in Phase 2.
Architectural rationale lives in `CLAUDE.md`; this doc is the operational
reference — what each knob does, what the cursor guarantees, and how to read
the logs when something looks off.

## Three sync entry points

All three converge on `runSync()` in `apps/backend/src/sync/runner.ts` and
share the same dedupe / idempotency / store contracts:

| Function         | Cron default   | What it does                                      |
| ---------------- | -------------- | ------------------------------------------------- |
| `runMembersSync` | `*/10 * * * *` | Workspace members → `users`                       |
| `runReposSync`   | `*/5 * * * *`  | Curated tracked-repo bootstrap → `repositories`   |
| `runCommitsSync` | `*/15 * * * *` | Per-repo commit delta pull across the curated set |

`make dev-sync` runs the cron host. The HTTPS API (`make dev-backend`) does
**not** schedule any cron — they're deliberately separate processes, so
stopping the API server doesn't stop the sync. Triggering work manually goes
through the admin endpoints (below); the same runner functions are reused.

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

## Configuration

All knobs have safe defaults — a fresh clone runs the cron without
overrides. Set in `.env` at the repo root.

| Env var                        | Default        | Notes                                              |
| ------------------------------ | -------------- | -------------------------------------------------- |
| `BITBUCKET_HOURLY_CALL_BUDGET` | `800`          | Soft cap on outbound BB calls per rolling hour.    |
| `SYNC_COMMITS_CRON`            | `*/15 * * * *` | When the commit cron fires.                        |
| `COMMITS_BACKFILL_MAX_PAGES`   | `5`            | Cold-mode cap: stop after N pages of 100.          |
| `COMMITS_BACKFILL_SINCE`       | _(empty)_      | Cold-mode cap: ISO 8601 date. Empty = no date cap. |
| `COMMIT_SYNC_CONCURRENCY`      | `3`            | Max repos in flight per tick.                      |
| `COMMIT_SYNC_BUDGET_THRESHOLD` | `20`           | Defer next repo when budget falls below this.      |

The members + repos crons (`SYNC_MEMBERS_CRON`, `SYNC_REPOS_CRON`) are also
overridable, but their defaults are intentionally tight for dev visibility —
lengthen in production if you want.

## Endpoints

### Admin (open by design — no auth, see `CLAUDE.md`)

| Endpoint                                                     | Purpose                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `POST /api/admin/sync/discover`                              | Members + curated repo bootstrap.                                   |
| `POST /api/admin/sync/commits`                               | Full commit tick. Returns `CommitsSyncResult` (summary + per-repo). |
| `POST /api/admin/sync/repositories/:workspace/:slug/commits` | Force a delta pull for one repo. 404 if not tracked.                |
| `POST /api/admin/repositories`                               | Add a repo to the tracked set. Body: `{ workspace, slug }`.         |

### Dashboard read side

| Endpoint                                                     | Returns                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /api/stats/overview`                                    | `{ users, repositories, projects, totalCommits, commitsLast7Days }`                  |
| `GET /api/stats/repositories/:workspace/:slug/latest-commit` | Newest commit + author, or 404 if the repo is untracked / has no ingested commits.   |
| `GET /api/stats/top-contributors?window=7d\|30d`             | Top 10 developers by commit count over the trailing window. Window defaults to `7d`. |

These hit `commits` directly. Phase 3 swaps in pre-aggregated rollups + a
Redis user-summary cache behind the same `StatsStore` interface.

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
                          hitKnownSha, hitPageCap, hitDateCap }
```

When in doubt, query `sync_state` directly:

```sql
SELECT r.full_name, s.last_seen_sha, s.last_sync_status,
       s.last_sync_error, s.total_commits_synced, s.last_synced_at
FROM sync_state s JOIN repositories r ON r.id = s.repository_id
ORDER BY s.last_synced_at DESC NULLS LAST;
```
