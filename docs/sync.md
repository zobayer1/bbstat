# Sync & data ingest

Operator + reader notes for the full sync pipeline — commit ingest (Phase 2),
the `commit_daily` rollup + Redis user-summary cache (Phase 3), and the
Phase 4 additions: per-commit diff stats, PR ingest, and the unified
`/api/activity` feed. Architectural rationale lives in `CLAUDE.md`; this doc
is the operational reference — what each knob does, what the cursors
guarantee, when the rollup drifts, and how to read the logs when something
looks off.

If you're reading this for the first time, start with "Backpressure
algorithm" below — it explains the load-bearing ideas (layered rate-limit
defense, derived queues, fair round-robin, sticky pacing across ticks) that
the rest of the pipeline composes against. Every other section in this doc
is a thin layer on top of that algorithm.

## Backpressure algorithm

The sync is shaped by one unforgiving constraint: BitBucket Cloud's rate
limit is **multi-tiered, partially undocumented, and asymmetric in what it
tells us about itself**. Specifically:

1. A documented **per-identity ~1000 calls/hour** soft cap, enforced as a
   rolling window on BB's side.
2. An **undocumented sub-second burst limiter** that fires at ~2-3 calls/sec
   sustained, even when the hourly count is well under cap.
3. On **success**, BB **omits the `X-RateLimit-*` headers entirely** (see
   `memory/bitbucket_rate_limit_headers.md`). The only signal we get is the
   `Retry-After` header on a 429.

The naive design — "just sleep `Retry-After` ms and retry" — collapses at
scale because the burst limiter latches: once it fires, hammering with
fixed-interval retries keeps it hot, and BB's eventual response is to refuse
every call for the rest of the rolling window. We get one cycle of dashboard
data per hour instead of every 5 minutes.

The pipeline solves this with **four layers of defense**, each addressing a
specific failure mode. Layers compose: an outer layer never trusts the
inner one to have gotten things right, so even if (for example) the call
pacer mispredicts BB's burst threshold, the budget gate and the tick-level
abort still cap the blast radius.

### Layer 1 — Self-counted call budget (hourly soft cap)

`BitbucketClient` maintains a **sliding-window ledger** of every outbound
fetch attempt — including retries, since each one costs against BB's
counter too. The ledger trims entries older than 1 hour opportunistically
on every `getCallsInLastHour()` read.

Why self-counted instead of trusting BB's headers: because BB returns no
headers on success, an externally-counted approach would be blind to the
99% of calls that succeed. We'd only learn the count from the 1% that 429.
The self-counted ledger is **always correct, even before BB notices**.

Operators consult `getBudgetRemaining()` (= `BITBUCKET_HOURLY_CALL_BUDGET` −
`getCallsInLastHour()`) at every tick boundary. Each tick orchestrator's
budget threshold (e.g. `COMMIT_SYNC_BUDGET_THRESHOLD`) acts as a hard floor:
when remaining falls below it, the worker stops scheduling new repos and
returns the remainder as `deferred[]`. The next cron tick picks them up.

### Layer 2 — Adaptive call pacing (sub-second burst defense)

Even at 500 BB calls/hour (well under the hourly budget), bursting them as
fast as Node can `fetch()` reliably trips the burst limiter — observed
empirically at ~2-3 calls/sec sustained. The pacer enforces a **minimum
wall-clock interval between successive calls**, sized to keep us under that
threshold without dragging out single-call admin endpoints.

The pacing isn't static — it's **adaptive on observed 429s**:

- Floor: `BITBUCKET_MIN_CALL_INTERVAL_MS` (default 400ms ≈ 2.5 calls/sec).
- Ceiling: `BITBUCKET_MAX_CALL_INTERVAL_MS` (default 3200ms).
- On a 429: double the current interval, capped at the ceiling.
  Default ramp: 400 → 800 → 1600 → 3200.
- After **20 consecutive non-429 responses** (`pacingDecaySuccesses`), halve
  the interval, floored at the minimum. Recovery is automatic; an operator
  never has to "reset" pacing.
- The current interval is **sticky across ticks** — the client instance
  lives for the process lifetime, so a 429 storm at minute 5 keeps us paced
  conservatively at minute 6 without re-discovering the limit.

The pacing wait only fires on the **initial** attempt of each request.
Retry waits (`Retry-After`, exponential backoff) already advance the
wall-clock past the pacing floor, so the pacer is a no-op in the retry
branch — no compounding penalty for the unlucky path.

### Layer 3 — Tick-level rate-limit abort

When pacing is pinned at the ceiling AND BB still 429s through the client's
in-request retry budget (`retries=3`), the client gives up and throws
`BitbucketRateLimitError`. This is the **abort signal** — meaning "we've
done everything we can locally; BB needs cooling time we don't have in
this tick window."

Every tick orchestrator catches that specific error type and:

- Puts the failing repo **back at the head of its queue** (it never made
  it to `markSyncSuccess`).
- Flips a tick-wide `stopReason = 'rate-limited'` flag so other workers
  exit on their next iteration check.
- Returns the rest of the queue as `deferred[]`.

The deepen tick has the same handler (`runDeepenTick` checks
`result.rateLimited` after each `deepenOneRepo` call and exits with
`stoppedReason: 'rate-limited'`). Both crons surface a `warn` log line —
**not error** — because this is expected backpressure, not a fault:

```
"commit tick: BB rate-limited at max pacing — yielding remaining queue to next tick"
"deepen-backfill: BB rate-limited — yielding remaining queue to next tick"
```

The next cron tick (5 minutes later) starts fresh — pacing has had time to
decay; BB's rolling window has rotated.

### Layer 4 — Fair round-robin across ticks

When a tick aborts, the deferred repos must surface before fresh ones on
the next tick — otherwise the bottom of the list starves under sustained
pressure. The fairness mechanism is structural rather than stateful:

```sql
-- DiscoveryStore.listTrackedRepositories()
SELECT … FROM repositories r
LEFT JOIN sync_state ss ON ss.repository_id = r.id
ORDER BY ss.last_synced_at ASC NULLS FIRST, r.id ASC
```

`last_synced_at` is only stamped on successful `markSyncSuccess`, so a repo
that 429'd mid-flight or was deferred entirely keeps its **stale (or
NULL) timestamp** and naturally sorts to the front of the next tick's queue.
`NULLS FIRST` puts never-synced repos at the very top — the same property
guarantees that newly added repos get cold-mode'd promptly.

The deepen tick has its own round-robin (`deepen_last_run_at ASC NULLS FIRST`
on `WHERE deepen_complete = false`) — every incomplete repo gets a fair
turn, never-attempted ones jump the queue once, then it's pure staleness
rotation.

### Putting it together — the four state variables

The whole algorithm is parameterized by four pieces of state, all owned by
either `BitbucketClient` or `sync_state`:

| State                                                   | Lives on                | Updated by                                       |
| ------------------------------------------------------- | ----------------------- | ------------------------------------------------ |
| `callTimestamps[]`                                      | `BitbucketClient`       | every `request()` call (counts retries)          |
| `currentPacingMs`                                       | `BitbucketClient`       | bumps on 429s, decays on clean streaks           |
| `lastCallAt`                                            | `BitbucketClient`       | every `request()` call (gates next call's start) |
| `last_synced_at` / `last_seen_sha`/`deepen_last_run_at` | `sync_state` (per-repo) | `markSyncSuccess` / `markDeepenAttempt`          |

Layer 1 reads `callTimestamps[]`. Layer 2 reads + writes `currentPacingMs`
and `lastCallAt`. Layer 3 throws `BitbucketRateLimitError` when retries
exhaust at the ceiling. Layer 4 reads `last_synced_at` to order the next
tick's queue.

There is **no explicit "is BB angry right now?" flag** — every backpressure
decision is derived from one of these four pieces of state, all of which
update naturally as work flows through.

### Multiple queues, one budget

The sync runs five derived queues simultaneously, all drawing from the same
hourly call budget:

| Queue           | Source                                                  | Order                                | Tick                      |
| --------------- | ------------------------------------------------------- | ------------------------------------ | ------------------------- |
| Members         | `runMembersSync` (cron only)                            | N/A — one workspace call             | `SYNC_MEMBERS_CRON`       |
| Discovery       | `runReposSync` (cron + admin)                           | YAML order from `tracked-repos.yaml` | `SYNC_REPOS_CRON`         |
| Commit (delta)  | `DiscoveryStore.listTrackedRepositories()`              | `last_synced_at ASC NULLS FIRST`     | `SYNC_COMMITS_CRON`       |
| Diff-stats      | `commits WHERE diff_stats_synced_at IS NULL` (per repo) | `authored_at DESC`                   | piggy-back on commit tick |
| Deepen-backfill | `sync_state WHERE deepen_complete = false`              | `deepen_last_run_at ASC NULLS FIRST` | piggy-back on commit tick |
| Pull-requests   | `DiscoveryStore.listTrackedRepositories()`              | `last_synced_at ASC NULLS FIRST`     | `SYNC_PRS_CRON`           |

None of these are persistent queue tables — every queue is **derived state**
materialised at tick start from `repositories` + `sync_state` + `commits`.
That means adding a repo, toggling diff-stats, or marking a repo as
`deepen_complete` takes effect at the next tick boundary with no
migration / no queue surgery.

Each queue has its own budget threshold (`COMMIT_SYNC_BUDGET_THRESHOLD`,
`DEEPEN_BUDGET_THRESHOLD`, etc.) calibrated so that the higher-value queues
(delta sync) yield to nothing, while lower-priority work (deepen) yields to
delta. The deepen threshold (100) is higher than the commit threshold (20),
so heavy delta ticks naturally starve deepen rather than the reverse —
freshness beats history.

### Why progressive pacing beats fixed sleep

A naive fixed-interval pacer has to choose a single value. Too low (200ms):
trips burst limit, abort cascades. Too high (2000ms): wastes calls per hour
even when BB is happy. Progressive pacing solves both:

- **In steady state** (BB happy): pacing decays to the floor (400ms),
  delivering the full call rate.
- **Under pressure** (1-2 isolated 429s): pacing climbs to 800-1600ms,
  letting BB's burst counter drain naturally, then decays back.
- **At sustained pressure** (4+ 429s in a row): pacing pins at 3200ms,
  client retries exhaust, tick aborts. Total damage = one tick's worth of
  work deferred to the next cron firing.

The 20-call decay window matters: it's long enough that a one-off 429 doesn't
ratchet pacing up and stick there, but short enough (~ 30s at floor pacing,
~ 4 min at ceiling) that recovery is brisk after a sustained spike.

## Four sync entry points

All four converge on `runSync()`-style functions in
`apps/backend/src/sync/runner.ts` and share the same dedupe / idempotency /
store contracts:

| Function              | Cron default   | What it does                                                                 |
| --------------------- | -------------- | ---------------------------------------------------------------------------- |
| `runMembersSync`      | `*/10 * * * *` | Workspace members → `users`                                                  |
| `runReposSync`        | `*/5 * * * *`  | Curated tracked-repo bootstrap → `repositories` (incl. `diff_stats_enabled`) |
| `runCommitsSync`      | `*/5 * * * *`  | Per-repo commit delta pull + one piggybacked deepen-backfill page per tick   |
| `runPullRequestsSync` | `0 * * * *`    | Per-repo PR delta pull across all four BB states                             |

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

The mechanism is covered conceptually under "Backpressure algorithm — Layer 1"
above. Operational specifics for the commit tick:

1. Up to `COMMIT_SYNC_CONCURRENCY` (default 3) repos in flight at once.
2. Before claiming the next repo, each worker re-checks
   `getBudgetRemaining()`. If it falls below `COMMIT_SYNC_BUDGET_THRESHOLD`
   (default 20), the worker stops scheduling new work and sets the tick's
   `stopReason = 'budget'`.
3. Unclaimed repos come back as `deferred[]` for the next tick;
   `stoppedEarly: true` flags this happened.
4. **Errors in one repo never abort siblings** — recorded per-repo in
   `errors[]`. The exception is `BitbucketRateLimitError`, which aborts
   the entire tick with `stopReason = 'rate-limited'` and unshifts the
   failing repo back to the head of `deferred[]`. See Layer 3.

The default budget (1000) runs at BB's documented per-identity cap; the
sliding-window ledger is conservative enough that hitting BB's actual
gate via this soft cap is extremely rare in practice. Drop the env var
back to ~800 if you want an explicit safety margin. The default
threshold (20) is sized above the worst-case per-repo cost
(`firstRunMaxPages × concurrency` = 15 + slack).

### Tick result shape

`runCommitsTick` returns:

```ts
{
  attempted: RepoCommitSyncResult[];  // repos that ran to completion
  deferred:  RepositoryHandle[];      // repos that didn't get a turn
  errors:    Array<{ repository, error: string }>;  // per-repo failures (non-rate-limit)
  stoppedEarly: boolean;              // true iff stopReason !== null
  stopReason: 'budget' | 'rate-limited' | null;
  budgetRemainingAtEnd: number;
}
```

The discriminated `stopReason` lets the runner log the precise cause and
lets future code branch on it (e.g. an admin endpoint could return 503 with
a different status code for budget-exhausted vs. rate-limited).

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

## Deepen-backfill (self-queueing, Phase 4 follow-up)

Cold-mode commit ingest stops at `COMMITS_BACKFILL_MAX_PAGES × 100`
(default 500) commits per repo. Anything older never gets fetched by
delta sync — which walks forward from the cursor, not backwards. To
fill in that permanent history floor, every `runCommitsSync` tick
**piggybacks** a deepen-backfill tick after the regular delta work.

The tick **drains the queue until the call budget runs out** — not
one repo per cron firing, the whole list per cron firing, capped by
whatever budget the delta tick left behind. Throughput is
budget-shaped: on a quiet day with little delta traffic, dozens of
repos drain per tick; on a busy day, just a couple.

How one tick proceeds:

1. After the delta tick finishes, the loop checks
   `getBudgetRemaining() >= DEEPEN_BUDGET_THRESHOLD` (default 100 —
   intentionally higher than the commit-tick threshold so deepen
   yields to delta) and stops the moment the answer is "no".
2. Each iteration asks `CommitStore.pickRepoForDeepening()` for the
   next candidate. Query: `SELECT … FROM sync_state WHERE
deepen_complete = false ORDER BY deepen_last_run_at ASC NULLS FIRST
LIMIT 1`. Never-attempted repos jump the queue once; after that
   it's pure staleness round-robin so every incomplete repo gets a
   fair turn within a tick.
3. The oldest known commit sha for that repo (`commits.authored_at
ASC LIMIT 1`) becomes the seed for an `include=<sha>` BB walk. BB
   returns that sha as the FIRST item — we skip it and ingest the
   ancestors via the same idempotent `insertCommits` path. Each repo
   page costs ~5 BB calls (5 paginations × 100 commits, the
   `DEEPEN_BACKFILL_MAX_PAGES` cap).
4. Tick result: `repos: DeepenBackfillResult[]` (zero or more) plus
   `stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete'`.
   - `'rate-limited'` — mirrors the commit tick (see Layer 3 in
     "Backpressure algorithm"). The failing repo is the last entry in
     `repos` with `rateLimited: true`.
   - `'rotation-complete'` — the tick gave every incomplete repo one
     turn this run. Common when most/all incomplete repos still have
     `oldestSha = null` (cold mode hasn't deposited any commits yet, or
     the repo has none on BB) — that path doesn't consume BB budget, so
     without this guard the loop would cycle indefinitely. The picker
     gets one full pass; the next cron firing picks up where we left
     off (or those repos finally get commits via the delta tick first).

How it stops, per repo:

- **Reaches root** — BB returns no `next` URL → `markDeepenComplete()`
  flips `deepen_complete = true`. The repo leaves the queue forever.
- **Hits the page cap** — drained `DEEPEN_BACKFILL_MAX_PAGES × 100`
  (default 500) commits this run. `deepen_complete` stays false; the
  next rotation picks this repo up from the new oldest sha.
- **Seed 404** — a force-push made our oldest sha disappear upstream.
  Treated as "give up": `deepen_complete = true`, logged.
- **Transient failure** (4xx other than 404, 5xx after retries) —
  leaves `deepen_complete` alone, just bumps `deepen_last_run_at` so
  the round-robin rotates past it on the next tick.

Manual trigger: `POST /api/admin/sync/repositories/:ws/:slug/deepen`
forces the specified repo to run one deepen page right now (bypasses
the round-robin pick but still respects the budget gate). Returns 404
on untracked, 503 on budget-below-threshold, otherwise the
`DeepenBackfillResult` shape.

Throughput is budget-shaped, not cron-shaped. Each deepen page costs
~5 BB calls; whatever headroom is left after the delta tick goes
straight into deepen. Worked example at the shipped defaults:

- 160 tracked repos, idle delta tick = ~160 BB calls
- `BITBUCKET_HOURLY_CALL_BUDGET = 1000` (BB Cloud's per-identity cap)
- 12 ticks/hour at the 5-min commit cron
- Idle delta theoretically wants 1920 calls/hour — over budget — so
  the gate naturally throttles to ~5–6 full sweeps/hour (~10-min
  effective polling per repo).
- PR cron hourly @ ~160 calls = 160 calls/hour overhead.
- Members cron 10-min @ ~1 call = 6 calls/hour. Discovery is ~0 at
  steady state.
- After all that, deepen gets whatever's left — typically near zero
  at this configuration.

If you want deepen to make visible progress at 160-repo scale, the
levers are:

1. **Relax the commit cron** — `*/15 * * * *` puts idle delta at
   640 calls/hour and leaves ~200 for deepen → ~40 deepen pages/hour
   = 40 repos × 500 commits = 20k commits/hour. Trade-off: "newest
   commits" latency climbs from ~10 min to ~15 min, which is fine
   for a contribution dashboard.
2. **Bump `COMMIT_SYNC_BUDGET_THRESHOLD`** (e.g., 200) so delta
   yields earlier — gives deepen guaranteed headroom even on busy
   ticks, at the cost of leaving some repos un-polled on tight
   ticks (they catch up the following tick).
3. **Use the manual admin endpoint** for one-shot drains:
   `POST /api/admin/sync/repositories/:ws/:slug/deepen` for a
   specific repo. Useful for bulk-backfilling priority repos
   without waiting for the round-robin.

The deepen tick is fully self-balancing: tune any of those knobs and
throughput adjusts without code changes.

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
  `PR_BACKFILL_MAX_PAGES × 50` PRs (BB Cloud caps `/pullrequests`
  pagelen at 50, unlike `/commits` at 100). Delta walks newest-first and stops
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

| Env var                            | Default       | Notes                                                                            |
| ---------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `BITBUCKET_HOURLY_CALL_BUDGET`     | `1000`        | Layer 1: hourly soft cap on outbound BB calls, shared across every sync surface. |
| `BITBUCKET_MIN_CALL_INTERVAL_MS`   | `400`         | Layer 2 floor: minimum wall-clock interval between successive BB calls.          |
| `BITBUCKET_MAX_CALL_INTERVAL_MS`   | `3200`        | Layer 2 ceiling: pacing doubles on each 429, capped here; abort triggers above.  |
| `SYNC_COMMITS_CRON`                | `*/5 * * * *` | When the commit cron fires. Also drives the piggybacked deepen-backfill step.    |
| `COMMITS_BACKFILL_MAX_PAGES`       | `5`           | Cold-mode commit cap: stop after N pages of 100.                                 |
| `COMMITS_BACKFILL_SINCE`           | _(empty)_     | Cold-mode commit cap: ISO 8601 date. Empty = no date cap.                        |
| `COMMIT_SYNC_CONCURRENCY`          | `3`           | Max repos in flight per commit tick.                                             |
| `COMMIT_SYNC_BUDGET_THRESHOLD`     | `20`          | Defer next repo when budget falls below this.                                    |
| `DEEPEN_BACKFILL_MAX_PAGES`        | `5`           | Self-queueing deepen-backfill: pages × 100 commits per piggybacked run.          |
| `DEEPEN_BUDGET_THRESHOLD`          | `100`         | Headroom required after the delta tick before deepen runs. Yields to delta sync. |
| `DIFF_STATS_MAX_PER_REPO_PER_TICK` | `50`          | Phase 4: per-repo pending-commit cap for the diff-stat worker.                   |
| `DIFF_STATS_BUDGET_THRESHOLD`      | `10`          | Phase 4: per-repo budget gate inside the diff-stat worker loop.                  |
| `SYNC_PRS_CRON`                    | `0 * * * *`   | Phase 4: when the PR cron fires (hourly). PR data mutates slower than commits.   |
| `PR_BACKFILL_MAX_PAGES`            | `5`           | Phase 4: cold-mode PR cap (pages × 100).                                         |
| `PR_SYNC_CONCURRENCY`              | `3`           | Phase 4: max repos in flight per PR tick.                                        |
| `PR_SYNC_BUDGET_THRESHOLD`         | `20`          | Phase 4: defer next repo when budget falls below this.                           |

The members + repos crons (`SYNC_MEMBERS_CRON`, `SYNC_REPOS_CRON`) are also
overridable, but their defaults are intentionally tight for dev visibility —
lengthen in production if you want.

## Endpoints

### Admin (open by design — no auth, see `CLAUDE.md`)

| Endpoint                                                          | Purpose                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /api/admin/sync/discover`                                   | Members + curated repo bootstrap. Result includes `diffStatsToggled`.                   |
| `POST /api/admin/sync/commits`                                    | Full commit tick. Returns `CommitsSyncResult` (summary + per-repo).                     |
| `POST /api/admin/sync/repositories/:workspace/:slug/commits`      | Force a delta commit pull for one repo. 404 if not tracked.                             |
| `POST /api/admin/sync/pullrequests`                               | Full PR tick. Returns `PrsSyncResult` (summary + per-repo).                             |
| `POST /api/admin/sync/repositories/:workspace/:slug/pullrequests` | Force a delta PR pull for one repo. 404 if not tracked.                                 |
| `POST /api/admin/sync/repositories/:workspace/:slug/deepen`       | Force one deepen-backfill page for one repo. 404 untracked; 503 budget-below-threshold. |
| `POST /api/admin/repositories`                                    | Add a repo to the tracked set. Body: `{ workspace, slug }`.                             |

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
                          stoppedEarly, stopReason, startedAt, finishedAt }
```

When the adaptive pacer reacts, the BB client itself emits:

```
"BitBucket 429 — increasing call pacing"  { path, previousPacingMs, newPacingMs, attempt }
"BitBucket 429 — backing off"             { path, retryAfter, attempt }
"BitBucket pacing decay — relaxing after clean streak"
                                          { previousPacingMs, newPacingMs, after }
```

And when a tick aborts on rate-limit:

```
"commit tick: BB rate-limited at max pacing — yielding remaining queue to next tick"
                                          { repository, pacingMs, deferred }
"deepen-backfill: BB rate-limited — yielding remaining queue to next tick"
                                          { repositoryId, fullName, retryAfterSeconds }
"deepen-backfill tick: yielded on BB rate limit"
                                          { repos, lastRepo }
```

These are **warn-level, not error**. A 429 storm and a tick abort are normal
backpressure events — the next cron firing recovers. Filter on `level >= error`
for actual faults; `BitbucketApiError` (non-429, non-404) is still error-level.

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
       s.pr_total_synced,
       s.deepen_complete,
       s.deepen_last_run_at
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

## Tuning playbook

Symptom-driven map from "what you're seeing in the logs" to "the knob that
fixes it." All four backpressure layers are tunable; defaults are calibrated
for BB Cloud + ~160 tracked repos, but other workspaces / mirrors may need
adjustment.

| Symptom                                                               | Likely cause                                                                            | Knob to try                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intermittent `"BitBucket 429 — backing off"`, no aborts               | Pacing floor is borderline — most calls fine, occasional burst trips BB.                | Bump `BITBUCKET_MIN_CALL_INTERVAL_MS` to 600. Trades throughput for fewer retries.                                                                   |
| Frequent `"commit tick: BB rate-limited"` aborts                      | Pacing ceiling reached and BB still 429s — sustained pressure from a different process? | Check for another sync process sharing the same BB identity. If sole consumer, raise `BITBUCKET_MAX_CALL_INTERVAL_MS` to 6400.                       |
| `commit sync complete` shows large `deferred` count consistently      | Delta tick is over-budget — too many repos, too tight a cron.                           | Relax `SYNC_COMMITS_CRON` (e.g., `*/10 * * * *`), or raise `COMMIT_SYNC_BUDGET_THRESHOLD` so the gate fires earlier and deferred repos stay smaller. |
| Deepen-backfill makes no visible progress                             | Delta is consuming the whole budget; deepen never gets a turn.                          | Relax commit cron OR raise `DEEPEN_BUDGET_THRESHOLD` (the deepen yields-to-delta gate) so delta gives up budget sooner.                              |
| A specific repo never appears in `attempted[]` across multiple ticks  | Sorted to the back of the queue under pressure, but somehow keeps getting deferred.     | Check `last_synced_at` in `sync_state`. If it's recent, sort is fine. If always-stale, look for a per-repo error in `errors[]` / `last_sync_error`.  |
| Pacing stuck high (`getCurrentPacingMs() = 3200`) hours after a spike | Decay isn't firing — possibly the process has been idle so no successes accumulated.    | Restart the sync host to reset state to floor — or just wait for the next tick to deliver 20+ clean responses.                                       |

The four backpressure layers cover almost every operational scenario
without code changes. Touching the rate-limit logic itself should be
reserved for: (a) BB itself changes their rate-limit policy, or (b) a new
deployment surface (e.g. dedicated webhook receiver) shifts the workload
shape enough that the assumed call patterns don't hold.
