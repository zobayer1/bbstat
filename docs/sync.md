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

The pipeline solves this with **five layers of defense**, each addressing a
specific failure mode. Layers 1–4 are inside the call path (how fast / how
many BB calls); layer 5 is upstream of it (which repos to even consider
this tick). Layers compose: an outer layer never trusts the inner one to
have gotten things right, so even if (for example) the call pacer
mispredicts BB's burst threshold, the budget gate and the tick-level
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

| Queue           | Source                                                                       | Order                                | Tick                      |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------ | ------------------------- |
| Members         | `runMembersSync` (cron only)                                                 | N/A — one workspace call             | `SYNC_MEMBERS_CRON`       |
| Discovery       | `runReposSync` (cron + admin)                                                | YAML order from `tracked-repos.yaml` | `SYNC_REPOS_CRON`         |
| Commit (delta)  | `listRepositoriesForSync()` filtered by `isDueForSync` (commit-list backoff) | `last_synced_at ASC NULLS FIRST`     | `SYNC_COMMITS_CRON`       |
| Diff-stats      | `commits WHERE diff_stats_synced_at IS NULL` (per opted-in repo, all)        | `authored_at DESC`                   | piggy-back on commit tick |
| Deepen-backfill | `sync_state WHERE deepen_complete = false`                                   | `deepen_last_run_at ASC NULLS FIRST` | piggy-back on commit tick |
| Pull-requests   | `listRepositoriesForSync()` filtered by `isDueForSync` (PR backoff)          | `last_synced_at ASC NULLS FIRST`     | `SYNC_PRS_CRON`           |

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

### Layer 5 — Adaptive per-repo backoff (cron-tick yield)

Layers 1–4 control _how fast_ we make BB calls. Layer 5 controls _which
repos we even consider_ per tick.

At ~100+ tracked repos, the idle-delta cost (1 BB call per repo, found
`last_seen_sha` on first page, stopped) is the dominant load. A
fully-quiet org would burn ~160 × 12 = 1920 calls/hr — over budget.
Worse, the fair round-robin (`last_synced_at ASC NULLS FIRST`)
_actively prioritises_ the longest-unsynced repos, which means dormant
repos crowd the queue and starve active ones.

The backoff layer skips quiet repos at the cron-tick boundary. Each
repo has an effective polling interval derived from how long it has
been quiet:

```
days_quiet      = (now - MAX(activity)) / 86400        // commits.authored_at for commit-sync,
                                                       // pull_requests.bitbucket_updated_at for PR-sync
intervalMin     = clamp(days_quiet × SLOPE, MIN, MAX)
due_for_sync    = (last_synced_at IS NULL)
               || (now - last_synced_at) >= intervalMin
```

Defaults (`SLOPE=4 min/day`, `MIN=5 min`, `MAX=1440 min`):

| Days quiet | Effective interval |
| ---------: | -----------------: |
|        0–1 |              5 min |
|          7 |             28 min |
|         30 |          2 h 0 min |
|         90 |          6 h 0 min |
|        180 |         12 h 0 min |
|       365+ |       24 h (clamp) |

Empty repos (no commits ever ingested) fall back to `repositories.created_at`
as the activity floor — so a freshly-tracked empty repo polls every
5 min until commits arrive (or it's been on the books long enough for
the backoff to kick in).

Self-healing: a quiet repo that suddenly receives a commit has
`MAX(authored_at)` reset to today → next tick its interval is back to
5 min. No reclassification logic; the formula re-evaluates each tick.

**What backoff does NOT affect:**

- **Diff-stats backfill tick** — receives the full unfiltered repo list,
  drains pending `/diffstat/:sha` fetches for any opted-in repo as long
  as budget allows. Diff-stats work is _independent_ of commit-list
  staleness — a repo whose commit-list check is skipped this tick can
  still have its pending diff stats walked.
- **Deepen-backfill tick** — picks its own repo via
  `pickRepoForDeepening()` (incomplete-deepen round-robin). Quiet repos
  still get history backfilled.
- **Manual admin triggers** — `/api/admin/sync/repositories/:ws/:slug/commits`
  and related hit `syncRepositoryCommits` directly without going through
  the listRepositoriesForSync filter. Operators always get an immediate
  sync regardless of staleness.

Logs surface `repoCount` (total non-archived) and `dueCount` (after
backoff filter) on every `commit sync start` / `PR sync start` line, so
you can watch the savings.

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

| Function              | Cron default   | What it does                                                                                                                          |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `runMembersSync`      | `*/10 * * * *` | Workspace members → `users`                                                                                                           |
| `runReposSync`        | `*/5 * * * *`  | Curated tracked-repo bootstrap → `repositories` (initial seed only)                                                                   |
| `runCommitsSync`      | `*/5 * * * *`  | Per-repo commit delta pull (with inline-eager /diffstat for new commits) → deepen-backfill tick → diff-stats backfill tick. See below |
| `runPullRequestsSync` | `0 * * * *`    | Per-repo PR delta pull across all four BB states                                                                                      |

`make dev-sync` runs the cron host. The HTTPS API (`make dev-backend`) does
**not** schedule any cron — they're deliberately separate processes, so
stopping the API server doesn't stop the sync. Triggering work manually goes
through the admin endpoints (below); the same runner functions are reused.

## Curated tracked set

The set of repos `runReposSync` / `runCommitsSync` / `runPullRequestsSync`
operate on is sourced from `tracked-repos.yaml` at the repo root (gitignored
— copy from `tracked-repos.yaml.example` on a fresh clone). The file holds
one top-level `repos:` list whose entries are either a plain
`"<workspace>/<slug>"` string (defaults — `diffStats=false`, `archived=false`)
or an object `{ name: "<workspace>/<slug>", diffStats?: boolean, archived?: boolean }`
for explicit per-flag seeding.

**YAML is seed-only.** `bootstrapTrackedRepositories` inserts brand-new repos
into `repositories` + `sync_state` using the YAML's per-flag values as the
initial column values. Once a row exists, the DB is canonical:
`diff_stats_enabled` and `archived` are flipped via admin endpoints
(`POST /repositories/:ws/:slug/archive`, `/unarchive`) or direct SQL, and
those changes survive every subsequent discovery sync. Editing the YAML for
an existing repo is a no-op for those flags — operators can trust their
runtime toggles aren't fighting the YAML reconciler.

The file is read on backend startup (one-time fail-loud parse check) and
re-read on every `runReposSync` / `runDiscoverySync` invocation, so adding a
**new** repo to the YAML lands at the next sync without a restart. A missing
file at the default path is a no-op; an explicit `SEED_REPO_FILE_PATH` that
doesn't exist fails loud at startup. Malformed YAML throws — at boot if bad
on startup, otherwise as the sync's error path (500 on `POST /sync/discover`,
error log under cron).

**Removal:** dropping a YAML entry does NOT untrack the repo (the row stays
in `repositories` and keeps getting synced). The intended retirement path is
`POST /api/admin/repositories/:ws/:slug/archive` — sets `archived = true`,
keeps every commit / sync_state / pull_request row intact for historical
queries, and excludes the repo from `listTrackedRepositories()` /
`listRepositoriesForSync()` so commit / deepen / diff-stats ticks skip it
entirely. Reversible via `/unarchive`. A hard delete (`DELETE FROM
repositories WHERE …`, cascading to commits / sync_state / pull_requests) is
still possible for "this repo was a mistake, drop everything" cases, but
the archive endpoint is the right answer for "stop syncing but keep the
data."

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

Per-commit `additions` / `deletions` / `files_changed` aren't populated
by the commit walk itself — that would mean one `/diffstat/:sha` call
per commit ingested across the entire backfill. Instead, diff-stat
ingest is gated on `repositories.diff_stats_enabled = true` and walks
commits via two independent paths:

- **Inline-eager (forward)** — runs _inside_ `syncRepositoryCommits`,
  immediately after `insertCommits` returns the newly-landed rows. Walks
  the just-inserted shas only (`fetchDiffStatsForCommits`); no DB pickup,
  no per-repo cap (input is bounded by however many new commits arrived
  this tick). Same-tick latency for new commits.
- **Backfill (backward)** — `runDiffStatsBackfillTick` runs _after_
  `runDeepenTick` in the same `runCommitsSync` invocation. Walks
  `commits WHERE diff_stats_synced_at IS NULL` across every opted-in
  repo, capped at `DIFF_STATS_BACKFILL_MAX_PER_REPO_PER_TICK` (default 100) per repo per tick, newest-authored-first. Catches up on (a) the
  historical backlog after a repo opts in, and (b) inline-eager
  transient failures (the row stays NULL → retried next tick).

A partial index (`commits_pending_diff_stats_idx (repository_id) WHERE
diff_stats_synced_at IS NULL`) keeps the backfill pickup query cheap as
the commit log grows.

Per commit (either path): one `/diffstat/:sha` call (or more for
multi-file mega-commits — BB paginates), sum lines across files (treating
NULL `lines_added/lines_removed` as zero for binary diffs), count
entries for `files_changed`, UPDATE `commits` with the totals and stamp
`diff_stats_synced_at = now()`. Per-commit fetch error logs and
continues — that one row stays NULL and gets retried on the next
backfill tick; siblings aren't affected.

**Independence from commit-sync backoff.** The inline-eager path is
gated transitively (it runs inside `syncRepositoryCommits`, which
backoff skips on quiet repos). The **backfill tick is NOT** — it
receives the full unfiltered opted-in repo list and drains pending
`/diffstat` work for any opted-in repo every cron tick, regardless of
whether commit-sync ran for that repo this tick. So flipping
`diff_stats_enabled = true` on a backed-off repo lights up the backfill
on the very next tick.

Once a repo is fully drained (`deepen_complete = true` AND no rows with
`diff_stats_synced_at IS NULL`), the backfill tick's cost per cron is
**1 DB query, 0 BB calls** — `listPendingDiffStatCommits()` returns `[]`
and the walker early-exits. Drained repos are also suppressed from the
tick result's `attempted[]` array (zero-update entries add noise without
signal); the `attemptedCount` field preserves the "did we even walk
this repo?" count.

**Self-paced rollout.** When the backfill tick finishes with zero work
across every opted-in repo (`totalUpdated + totalFailed + totalDeferred
=== 0`), `runCommitsSync` flips `diff_stats_enabled = true` on the next
non-opted-in non-archived repo. Selection is ordered by
`MAX(commits.authored_at) DESC NULLS LAST` (tie-broken on `id ASC`):
hot repos are promoted first so the dashboard sees fresh diff-stat
coverage for current work before it backfills dormant ones. One repo
per cron tick max. The natural drain time of the newly-opted-in repo's
backlog paces the rollout: a busy repo with 5,000 pending commits
blocks the next auto-opt for ~100 ticks (drain at the 50-per-tick cap);
an empty / already-drained repo lets the rollout proceed to the next
candidate on the very next tick. Eventually the whole tracked set is
opted in, with no manual operator action and no risk of running over
the hourly budget. Visible in logs as `diff-stats auto-opt-in` and on
`CommitsSyncResult.diffStatsAutoOptIn`. To pause the rollout, manually
flip a repo's flag back via SQL — the next tick's "all drained" check
will keep moving forward unless every candidate has been processed.

`is_merge` is captured at commit-insert time from BB's `parents.length >
1`. The flag is independent of diff-stat fetch state: a merge commit
still has its /diffstat fetched (the line counts represent the merged
branch's full delta, not authorship volume — surfaced in the activity
feed as a "merge" pill). User-facing 30-day aggregates over
additions/deletions default-exclude `is_merge = true` rows. For repos
whose history pre-dates the `is_merge` column (migration 0006),
`POST /api/admin/repositories/:ws/:slug/backfill/is_merge` walks BB's
/commits and bulk-UPDATEs the column by sha — see [docs/admin.md](admin.md).

Rollup interaction: `commit_daily` aggregates additions / deletions /
files_changed from `commits`. The rollup hook in
`dashboard/rollup-hook.ts` recomputes the `commit_daily` day window
whenever either `inserted > 0` (inline-eager) OR `diffStatsUpdated > 0`
(backfill), passing the union of `insertedRange` and `diffStatsRange` to
`recomputeCommitDailyForRepo`. Cache invalidation widens to the same
range.

## Tick execution order

The five tick-level orchestrators inside `runCommitsSync` execute in a
deterministic order, all sharing the same hourly BB-call budget. The
shape below shows one cron firing end-to-end — useful when reading a
log line back-to-front:

```
runCommitsSync()
│
├─ listRepositoriesForSync()                   ← one query: repo rows
│                                                + activity timestamps
│                                                + last-sync timestamps
│
├─ filter handles → dueHandles                 ← Layer 5 backoff
│   (isDueForSync per repo: due iff
│    now - lastSyncedAt >= interval(daysQuiet))
│
├─ runCommitsTick(dueHandles)
│   for each due repo, concurrent ≤ COMMIT_SYNC_CONCURRENCY:
│   ├─ syncRepositoryCommits():
│   │  ├─ paginate /commits stopping at lastSeenSha
│   │  ├─ insertCommits()                       ← new commits land
│   │  │                                          (diff_stats_synced_at = NULL,
│   │  │                                           is_merge from parents.length>1)
│   │  ├─ markSyncSuccess()                     ← cursor + last_synced_at
│   │  └─ if (diffStatsEnabled && insertedRows > 0):
│   │     └─ fetchDiffStatsForCommits()         ★ INLINE-EAGER /diffstat ★
│   │                                             walks just-inserted shas,
│   │                                             stamps diff_stats_synced_at
│   └─ rollup hook recomputes commit_daily over
│      insertedRange ∪ diffStatsRange
│
├─ runDeepenTick()                              ← picks ONE repo via
│   pickRepoForDeepening (deepen_complete=false,
│   round-robin on deepen_last_run_at)
│   ├─ if budget < DEEPEN_BUDGET_THRESHOLD: return
│   └─ deepenOneRepo: walk one backfill page,
│      inserts older commits (diff_stats_synced_at = NULL),
│      stamps deepen_complete = true if reached root
│
└─ runDiffStatsBackfillTick(handles)            ← FULL opted-in list,
                                                  ignores Layer 5 backoff
   for each opted-in repo, concurrent ≤ DIFF_STATS_BACKFILL_CONCURRENCY:
   ├─ if budget < DIFF_STATS_BACKFILL_BUDGET_THRESHOLD: defer
   ├─ listPendingDiffStatCommits(repo, 50)       ← pickup
   │  (commits WHERE diff_stats_synced_at IS NULL
   │   ORDER BY authored_at DESC LIMIT 50)
   └─ walk + fetch /diffstat per commit, stamp
      diff_stats_synced_at, rollup recompute for the touched range
```

A few invariants worth naming:

- **Same-tick coverage for forward stats.** A new commit ingested by
  `runCommitsTick` has its `/diffstat` fetched in the same per-repo
  function call (inline-eager). By the time `runDiffStatsBackfillTick`
  runs at the end of the cron, those just-inserted rows are already
  stamped and won't appear in the pickup. The backfill is strictly the
  catch-up path for historical and retry work.
- **Three independent budget gates, one ledger.** `COMMIT_SYNC_BUDGET_THRESHOLD`
  (default 20), `DEEPEN_BUDGET_THRESHOLD` (default 100), and
  `DIFF_STATS_BACKFILL_BUDGET_THRESHOLD` (default 20) each yield at a
  different point. Higher thresholds = more reserved headroom = lower
  priority. Deepen yields first (high threshold) so an aggressive
  commit-sync tick doesn't starve forward freshness; diff-stats
  backfill runs last and uses whatever slack survives.
- **Layer 5 only affects forward delta sync.** Deepen has its own queue
  (`pickRepoForDeepening`); diff-stats backfill iterates the unfiltered
  opted-in list. A repo backed off for delta sync still gets historical
  deepen + diff-stats backfill on every tick.
- **Idempotent at every step.** Re-running a tick (manual + cron racing,
  or a retry after a partial failure) converges: insertCommits dedupes
  on `(repository_id, sha)`, diff-stat fetches no-op on rows already
  stamped, deepen picks the next round-robin candidate.

`runPullRequestsSync` follows a simpler shape: `listRepositoriesForSync()`
→ filter by `isDueForSync` (keyed on `latestPrAt` + `prLastSyncedAt`)
→ `runPullRequestsTick(dueHandles)`. No deepen, no backfill — PR state
is mutable, so the regular delta walk handles updates inline.

## Pull-request ingest (Phase 4)

PR ingest runs on its own hourly cron (`SYNC_PRS_CRON` default `0 * * * *`)
— PRs mutate slower than commits, and a tighter cadence would waste budget.
Same Layer 5 backoff as commit-sync applies, keyed on
`MAX(pull_requests.bitbucket_updated_at)` rather than commits. The
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

| Env var                                     | Default       | Notes                                                                                  |
| ------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `BITBUCKET_HOURLY_CALL_BUDGET`              | `1000`        | Layer 1: hourly soft cap on outbound BB calls, shared across every sync surface.       |
| `BITBUCKET_MIN_CALL_INTERVAL_MS`            | `400`         | Layer 2 floor: minimum wall-clock interval between successive BB calls.                |
| `BITBUCKET_MAX_CALL_INTERVAL_MS`            | `3200`        | Layer 2 ceiling: pacing doubles on each 429, capped here; abort triggers above.        |
| `SYNC_COMMITS_CRON`                         | `*/5 * * * *` | When the commit cron fires. Also drives the piggybacked deepen-backfill step.          |
| `COMMITS_BACKFILL_MAX_PAGES`                | `5`           | Cold-mode commit cap: stop after N pages of 100.                                       |
| `COMMITS_BACKFILL_SINCE`                    | _(empty)_     | Cold-mode commit cap: ISO 8601 date. Empty = no date cap.                              |
| `COMMIT_SYNC_CONCURRENCY`                   | `3`           | Max repos in flight per commit tick.                                                   |
| `COMMIT_SYNC_BUDGET_THRESHOLD`              | `20`          | Defer next repo when budget falls below this.                                          |
| `DEEPEN_BACKFILL_MAX_PAGES`                 | `5`           | Self-queueing deepen-backfill: pages × 100 commits per piggybacked run.                |
| `DEEPEN_BUDGET_THRESHOLD`                   | `100`         | Headroom required after the delta tick before deepen runs. Yields to delta sync.       |
| `DIFF_STATS_BUDGET_THRESHOLD`               | `10`          | Phase 4: inline-eager forward fetch budget gate inside the commit-sync per-repo loop.  |
| `DIFF_STATS_BACKFILL_MAX_PER_REPO_PER_TICK` | `100`         | Phase 4: per-repo pending-commit cap for the diff-stats _backfill_ tick (post-deepen). |
| `DIFF_STATS_BACKFILL_BUDGET_THRESHOLD`      | `20`          | Phase 4: budget gate for the backfill tick.                                            |
| `DIFF_STATS_BACKFILL_CONCURRENCY`           | `1`           | Phase 4: max repos in flight for the backfill tick (serial by default).                |
| `SYNC_PRS_CRON`                             | `0 * * * *`   | Phase 4: when the PR cron fires (hourly). PR data mutates slower than commits.         |
| `PR_BACKFILL_MAX_PAGES`                     | `5`           | Phase 4: cold-mode PR cap (pages × 100).                                               |
| `PR_SYNC_CONCURRENCY`                       | `3`           | Phase 4: max repos in flight per PR tick.                                              |
| `PR_SYNC_BUDGET_THRESHOLD`                  | `20`          | Phase 4: defer next repo when budget falls below this.                                 |
| `SYNC_BACKOFF_SLOPE_MIN_PER_QUIET_DAY`      | `4`           | Layer 5: minutes added to the polling interval per day a repo has been quiet.          |
| `SYNC_BACKOFF_MIN_INTERVAL_MIN`             | `5`           | Layer 5: floor on the per-repo polling interval (default matches the commit cron).     |
| `SYNC_BACKOFF_MAX_INTERVAL_MIN`             | `1440`        | Layer 5: ceiling on the per-repo polling interval (24h default).                       |

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
