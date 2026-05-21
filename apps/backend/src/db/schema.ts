import { sql } from 'drizzle-orm';
import {
  pgSchema,
  serial,
  text,
  timestamp,
  date,
  integer,
  boolean,
  doublePrecision,
  index,
  unique,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';

// All tables / enums / sequences live under the `bbstat` schema, NOT the
// Postgres default `public`. Production environments are configured with
// a restricted role that has no CREATE on `public` (organizational policy),
// so the entire application schema is namespaced explicitly.
//
// MAINTAINER NOTE: drizzle-kit emits `CREATE SCHEMA "bbstat";` in the
// initial migration without `IF NOT EXISTS`. That breaks production
// installs where the DBA has pre-created the schema before the role has
// CREATE on the database. After running `make db-generate`, if the
// generated migration's first statement is plain `CREATE SCHEMA "…"`,
// patch it to `CREATE SCHEMA IF NOT EXISTS "…"` (and mirror in
// apps/backend/schema/). Only matters when the initial 0000 is
// regenerated — incremental migrations on top of an existing schema
// don't trigger this path.
export const bbstatSchema = pgSchema('bbstat');

// Postgres `tsvector` — used for the commit message FTS column. We never
// read this column from TypeScript (it's a derived index target only), so
// the `data` shape is `unknown`. The column is `GENERATED ALWAYS AS … STORED`
// in the table definition below, so it's also implicitly read-only.
const tsvector = customType<{ data: unknown; driverData: string; notNull: false; default: false }>({
  dataType() {
    return 'tsvector';
  },
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const syncStatusEnum = bbstatSchema.enum('sync_status', ['idle', 'running', 'success', 'failed']);

export const pullRequestStateEnum = bbstatSchema.enum('pull_request_state', [
  'OPEN',
  'MERGED',
  'DECLINED',
  'SUPERSEDED',
]);

// Persona badge assigned to a user by the nightly scoring rollup. NULL on
// `user_score.badge` means "Regular" (no persona matched) or "Dormant"
// (`is_dormant = true`) — the UI distinguishes the two from `is_dormant`,
// not from a separate enum value. Cascade order + thresholds live in
// docs/scoring.md; the badge classifier is the single writer.
export const userBadgeEnum = bbstatSchema.enum('user_badge', [
  'fresh_meat',
  'deep_diver',
  'ai_alex',
  'steady_eddie',
  'batch_betty',
  'cleanup_crew',
]);

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

// `email` captures the `<email>` portion of commits.author.raw on first
// ingest and is then write-once via COALESCE — once set it sticks. This is
// the contributor's git-configured email, NOT a verified workspace email
// (BB's `/workspaces/{ws}/members` endpoint never returned email even when
// it was public). Caveats apply to display: same person can use multiple
// git emails across machines (corp vs personal), BB synthesizes
// `noreply@bitbucket.org` for web-merge commits, and a fresh laptop can
// produce a one-off bogus email. The write-once policy means whatever
// landed first sticks; we don't keep overwriting because the "last
// observed" email isn't meaningfully more correct than the first.
// noreply addresses are filtered out at ingest so they never poison the
// column. Plumbed in commits.ts forward sync + deepen-backfill.ts via
// CommitStore.setUserEmailsIfMissing; surfaced in the WorkspaceMember
// payload + /members table.
// `is_workspace_member` distinguishes rows discovered via
// `/workspaces/{ws}/members` (TRUE) from rows auto-created during
// commit ingest when BB attributed a commit to a UUID we hadn't seen
// before (FALSE — typically ex-employees, never-members, or external
// contributors who pushed to a public repo). Member sync forces TRUE on
// every current member it sees, so a previously-auto-created user who
// rejoins the workspace flips back to TRUE on the next tick. The UI
// uses the flag to mute out-of-workspace contributors in member lists
// and filter "active team" vs "all-time contributors" leaderboards.
export const users = bbstatSchema.table('users', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  displayName: text('display_name').notNull(),
  username: text('username'),
  email: text('email'),
  isWorkspaceMember: boolean('is_workspace_member').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// `repositories` represents the curated *tracked* set — rows here that
// are not archived are what sync workers walk. `tracked-repos.yaml` is a
// **seed file**, not a live config source: it controls which repos get
// inserted on first discovery, and seeds the initial value of
// `archived`. Once a row exists, the DB is canonical — admin endpoints
// / scripts / ad-hoc SQL update the flags, and subsequent discovery
// syncs do NOT overwrite them from YAML. See docs/ROADMAP.md
// "Curated list growth".
//
// `archived` — Phase 4 follow-up. Soft-retire flag for repos that
// should keep their historical data but stop appearing in sync work.
// `listTrackedRepositories()` filters `archived = false`. Seeded from
// `{ name, archived: true }` in YAML on initial insert; flipped at
// runtime via POST /repositories/:ws/:slug/archive (or unarchive). No
// cascade — commits / sync_state stay intact so the data is still
// available for dashboards and historical queries.
//
// `sync_excluded` — same effect as `archived` (filtered out of every
// sync tick), but written by the sync layer itself when it detects a
// permanently-broken state. `sync_exclude_reason` records WHY so the
// dashboard and operator can act on it. Three auto-trip causes today:
//
//   - 'repo-404'           — the commits endpoint returned 404 (the
//                            repo was renamed or deleted upstream).
//   - 'empty-on-bitbucket' — cold-mode + deepen converged with zero
//                            commits ever ingested (BB has nothing).
//   - 'history-rewritten'  — delta sync walked BB's full history
//                            without finding our last_seen_sha
//                            (force-push rewrote the branch).
//
// Distinct from `archived` so the UI can surface "needs attention"
// separately from operator-initiated retirement, and so admin recovery
// (rename, include-back-into-sync, delete) has its own lifecycle. NULL
// reason on a non-excluded row, populated string on an excluded row.
//
// `diff_stats_enabled` was removed in 2026-05. Diff-stat ingest is no
// longer per-repo opt-in — every non-archived non-excluded repo
// participates automatically and the backfill tick uses a global
// freshness-first pickup across the entire pool. Operator opt-out
// goes through `archived` (full retirement) or per-file
// `diff_stats_exclude_patterns` (skip specific paths).
export const repositories = bbstatSchema.table('repositories', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  workspace: text('workspace').notNull(),
  project: text('project'),
  slug: text('slug').notNull(),
  fullName: text('full_name').notNull(),
  archived: boolean('archived').notNull().default(false),
  syncExcluded: boolean('sync_excluded').notNull().default(false),
  syncExcludeReason: text('sync_exclude_reason'),
  // Per-repo blacklist of file-path globs that the diff-stat aggregator
  // skips. Picomatch syntax (gitignore-style). Patterns are additive
  // per repo — no global defaults are layered on, so the operator's
  // canonical "what counts" view lives entirely in this column.
  // Empty array = unfiltered (every BB diffstat entry is summed).
  // Editing this column is cheap (cheap UPDATE); applying the change
  // to already-ingested commits requires POST /diff-stats/reset which
  // clears the diff_stats_synced_at stamps and lets the backfill tick
  // re-fetch with the new filter.
  diffStatsExcludePatterns: text('diff_stats_exclude_patterns')
    .array()
    .notNull()
    .default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// `diff_stats_synced_at` is the Phase 4 resumability marker for per-commit
// diff-stat ingest. NULL = "diff stats not fetched yet" (the only state at
// insertion time). Set to now() once /diffstat/:sha lands and additions /
// deletions / files_changed are persisted. The partial index
// commits_pending_diff_stats_idx makes the pickup query (`WHERE
// repository_id = $1 AND diff_stats_synced_at IS NULL`) cheap regardless of
// how large `commits` grows.
//
// `is_merge` mirrors BB's `parents.length > 1` and is populated at
// insert time. User-facing addition/deletion/files aggregates default-
// exclude merges (a single merge inflates per-file stats by the full
// branch delta, dwarfing real authorship). The flag is captured for every
// commit regardless of diff-stat opt-in.
//
// `files_changed` is the count of file entries in /diffstat/:sha. Filled
// alongside additions/deletions when the diff-stats step lands. Per-repo
// opt-in was removed in 2026-05; every non-archived non-excluded repo
// participates. Until /diffstat lands for a commit, all three columns
// stay at their defaults (additions=0, deletions=0, files_changed=0,
// diff_stats_synced_at=NULL) — the partial index keys the backfill
// pickup on that NULL stamp.
export const commits = bbstatSchema.table(
  'commits',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    sha: text('sha').notNull(),
    message: text('message').notNull(),
    isMerge: boolean('is_merge').notNull().default(false),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    filesChanged: integer('files_changed').notNull().default(0),
    // Cumulative count of failed `/diffstat/<sha>` fetch attempts for this
    // commit. Incremented by the diff-stats orchestrator on every caught
    // error (BB 5xx surfaced from the BB client's exhausted in-tick
    // retry budget): generic 5xx adds 1, HTTP 555 adds 3 — 555 means
    // "BB compute timeout on this commit's diff", which is a persistent
    // property of the commit shape (heavy file count, deep tree,
    // rename-detection blow-up) rather than transient load. When the
    // count reaches DIFF_STATS_FAILURE_THRESHOLD (3) the orchestrator
    // also calls updateCommitDiffStats with zeros — stamping
    // diff_stats_synced_at = NOW() drops the commit out of the pickup
    // query for good, so we stop burning BB budget on it. The counter
    // value survives the stamp so downstream readers (and the activity
    // feed) can distinguish "we tried 3 times and gave up" from "this
    // commit genuinely has zero changes". UI: ActivityFeed +
    // CommitDetailModal swap the +/-/files line for an exclamation
    // icon when count >= threshold.
    diffStatsFailureCount: integer('diff_stats_failure_count').notNull().default(0),
    diffStatsSyncedAt: timestamp('diff_stats_synced_at', { withTimezone: true }),
    // Author-snapshot columns. Populated at ingest from BB's
    // `author.raw` + `author.user.display_name`. NULL when BB doesn't
    // carry enough metadata (e.g. malformed author.raw) — `author_email`
    // additionally NULL for noreply-filtered addresses (see
    // parseAuthorEmail). Stored on the commit (not just on `users`) for
    // three reasons: (1) the value is immutable per commit and shouldn't
    // drift if the user later renames; (2) anonymous rows (no
    // author_user_id) can still carry the email/name they were pushed
    // with, leaving a hook for future reprocessing; (3) the
    // forthcoming step-2 backfill pulls from `users` for already-
    // attributed rows without a BB call, so anything keyed on these
    // columns can stop joining once they're populated. Both columns
    // are read-only from the application's perspective after ingest.
    authorEmail: text('author_email'),
    authorDisplayName: text('author_display_name'),
    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    // FTS index target for the dedicated Activity page's commit-message
    // search. `simple` dictionary (no stemming, no stopword removal) keeps
    // it predictable across the multilingual / acronym-heavy commit corpus
    // we see in practice — `to_tsquery('english', 'fixes')` would miss
    // "fix" / "fixed" / non-English vocabulary. GENERATED STORED so the
    // column backfills on add and stays in lockstep with `message` on
    // every insert / update — no application-side write needed.
    messageTsv: tsvector('message_tsv').generatedAlwaysAs(sql`to_tsvector('simple', message)`),
  },
  (t) => ({
    shaRepoUnique: uniqueIndex('commits_sha_repo_unique').on(t.repositoryId, t.sha),
    authorAuthoredIdx: index('commits_author_authored_idx').on(t.authorUserId, t.authoredAt),
    pendingDiffStatsIdx: index('commits_pending_diff_stats_idx')
      .on(t.repositoryId)
      .where(sql`${t.diffStatsSyncedAt} IS NULL`),
    // GIN index for the FTS column — drives `message_tsv @@ plainto_tsquery(…)`
    // lookups on the Activity page. Updated automatically with the generated
    // column so insert paths don't touch it.
    messageTsvIdx: index('commits_message_tsv_idx').using('gin', t.messageTsv),
    // B-tree on `sha` with the `text_pattern_ops` opclass so the Activity
    // page's hash-prefix search (`sha LIKE 'abc%'`) is index-driven
    // instead of a full scan. The existing `commits_sha_repo_unique` index
    // is on (repository_id, sha) which can't serve a SHA-only prefix scan.
    shaPrefixIdx: index('commits_sha_prefix_idx').using('btree', sql`${t.sha} text_pattern_ops`),
  }),
);

// Per-day per-(repo, user) commit rollup. Populated by the sync runner after
// each successful per-repo commit tick (see dashboard/rollup-store.ts). The
// dashboard reads from this table instead of re-scanning `commits` on every
// request, keeping query latency flat as the commit log grows.
//
// `author_user_id` is nullable: anonymous / unmatched-author commits get a
// single row per (day, repository_id) thanks to NULLS NOT DISTINCT on the
// unique index — without it, NULL would compare unequal and we'd accumulate
// one duplicate per anonymous commit. Postgres ≥ 15 required.
//
// `commit_count` is **non-merge only** — user-level rollups (per-author
// counts, the scoring rollup in `user_score`) sum it as-is. `merge_commit_count`
// is the merge counterpart, and is summed alongside ONLY for repo-level
// activity displays (where a merge into `main` is a real event for the
// repo). Splitting the column was load-bearing for the scoring rollup:
// merges inflate per-author churn (a single merge equals the entire branch
// delta attributed to whoever clicked the button) and would dominate any
// user-level metric if counted. `additions` / `deletions` here are already
// non-merge for the same reason — see commits.is_merge for the underlying
// flag and the ingest path in sync/commit-store.ts for how the split is
// enforced at write time.
export const commitDaily = bbstatSchema.table(
  'commit_daily',
  {
    day: date('day').notNull(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    commitCount: integer('commit_count').notNull().default(0),
    mergeCommitCount: integer('merge_commit_count').notNull().default(0),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // UNIQUE constraint (not index) because Drizzle 0.36's `.nullsNotDistinct()`
    // is exposed on `unique()` but not on `uniqueIndex()`. ON CONFLICT can
    // still target it by constraint name. NULLS NOT DISTINCT makes anonymous
    // commits (author_user_id IS NULL) collapse to one row per (day, repo).
    dayRepoUserUnique: unique('commit_daily_day_repo_user_unique')
      .on(t.day, t.repositoryId, t.authorUserId)
      .nullsNotDistinct(),
    repoDayIdx: index('commit_daily_repo_day_idx').on(t.repositoryId, t.day),
    userDayIdx: index('commit_daily_user_day_idx').on(t.authorUserId, t.day),
  }),
);

// Per-user ShipShow Score rollup. One row per user. Fully recomputed by the
// nightly scoring rollup (scoring/rollup.ts) — never written incrementally,
// so streaming-staleness questions don't apply. The leaderboard API reads
// from this table; nothing runs the scoring math on the request path.
//
// See docs/scoring.md for the formulas, constants (ALPHA=1.2, FLOOR=500,
// HALF_LIFE=30d, BETA=0.25), eligibility filter, badge cascade, and the
// 2026-05-21 corpus calibration that picked the thresholds.
//
// All `score_*` and `volume_*` columns sum `score_commit = ln(1+capped_adds)
// + ALPHA * ln(1+capped_dels)` over eligible commits. `score_trending`
// additionally applies an `exp(-ln(2)*age_days/30)` decay weight per commit
// — un-bounded in time, recent activity dominates. The fixed-window
// `volume_*` columns apply no decay and a hard cutoff at the window edge.
// `volume_all` is the un-bounded un-decayed sum.
//
// Eligible commits: `is_merge=false AND diff_stats_synced_at IS NOT NULL
// AND diff_stats_failure_count < 3 AND author_user_id IS NOT NULL`. The
// `commits_eligible / commits_total` ratio is materialized as
// `coverage_pct` so the UI can flag rows whose score is based on
// incomplete diff-stat ingest without joining `commits` on the read path.
//
// `consistency_90d` is NULL on cold-start (`active_days_90d < 3`); the UI
// shows "—" and drops these rows to the bottom of a consistency sort.
// `is_dormant = (active_days_90d = 0)` is the gray-out flag.
//
// `badge` is the cascaded persona (NULL = Regular / Dormant). Single
// writer (the rollup); never edited by the application.
export const userScore = bbstatSchema.table(
  'user_score',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),

    // Coverage — used by the UI to warn when a user's score is based on
    // partial diff-stat ingest. `commits_total` includes merges and
    // pending-diff-stat rows so the ratio reflects ingest progress, not
    // just the scoring filter.
    commitsEligible: integer('commits_eligible').notNull().default(0),
    commitsTotal: integer('commits_total').notNull().default(0),
    coveragePct: doublePrecision('coverage_pct').notNull().default(0),

    // Per-dev p95 of raw_churn clipped against the global FLOOR. The cap
    // that every per-commit score in this row was computed against.
    p95ChurnCap: integer('p95_churn_cap').notNull().default(0),

    // Decayed global score — default sort key on the leaderboard.
    scoreTrending: doublePrecision('score_trending').notNull().default(0),

    // Un-decayed per-window volume sums.
    volume7d: doublePrecision('volume_7d').notNull().default(0),
    volume30d: doublePrecision('volume_30d').notNull().default(0),
    volume90d: doublePrecision('volume_90d').notNull().default(0),
    volume365d: doublePrecision('volume_365d').notNull().default(0),
    volumeAll: doublePrecision('volume_all').notNull().default(0),

    // Consistency over a fixed 90d window — NULL when cold-start (<3
    // active days in window). Decoupled from the volume-window slider on
    // purpose (working style doesn't slide with the recency dial).
    consistency90d: doublePrecision('consistency_90d'),
    activeDays90d: integer('active_days_90d').notNull().default(0),

    // Badge classifier inputs derived from the 90d eligible commit set.
    medianChurn90d: integer('median_churn_90d').notNull().default(0),
    p95Churn90d: integer('p95_churn_90d').notNull().default(0),

    // Cascade output. NULL = Regular (no persona matched) or Dormant
    // (see `is_dormant`). UI distinguishes those two from `is_dormant`.
    badge: userBadgeEnum('badge'),
    isDormant: boolean('is_dormant').notNull().default(false),

    // Tenure — drives the `fresh_meat` badge cascade entry and a
    // "joined N days ago" hint in the UI. Computed from the oldest
    // commit's `authored_at` regardless of eligibility (we want the
    // wall-clock tenure, not the scored tenure).
    daysSinceFirstCommit: integer('days_since_first_commit').notNull().default(0),
  },
  (t) => ({
    // Default sort key on the leaderboard. NULLS LAST so any future
    // never-scored row sinks to the bottom rather than the top.
    trendingIdx: index('user_score_trending_idx').on(t.scoreTrending.desc().nullsLast()),
    // The 30d window is what the UI surfaces by default in the table.
    // Skip indexes for the other windows — 110 rows fits in cache and a
    // full sort is free at this scale.
    volume30dIdx: index('user_score_volume_30d_idx').on(t.volume30d.desc().nullsLast()),
  }),
);

export const branches = bbstatSchema.table(
  'branches',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    targetSha: text('target_sha').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoNameUnique: uniqueIndex('branches_repo_name_unique').on(t.repositoryId, t.name),
  }),
);

export const pullRequests = bbstatSchema.table(
  'pull_requests',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    // Numeric PR id within the repo (the BitBucket "id" field, not the UUID)
    bitbucketPrId: integer('bitbucket_pr_id').notNull(),
    title: text('title').notNull(),
    state: pullRequestStateEnum('state').notNull(),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    sourceBranch: text('source_branch').notNull(),
    destinationBranch: text('destination_branch').notNull(),
    sourceSha: text('source_sha'),
    destinationSha: text('destination_sha'),
    commentCount: integer('comment_count').notNull().default(0),
    taskCount: integer('task_count').notNull().default(0),
    bitbucketCreatedAt: timestamp('bitbucket_created_at', { withTimezone: true }).notNull(),
    bitbucketUpdatedAt: timestamp('bitbucket_updated_at', { withTimezone: true }).notNull(),
    bitbucketClosedAt: timestamp('bitbucket_closed_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoPrUnique: uniqueIndex('pull_requests_repo_pr_unique').on(t.repositoryId, t.bitbucketPrId),
    repoStateIdx: index('pull_requests_repo_state_idx').on(t.repositoryId, t.state),
    authorUpdatedIdx: index('pull_requests_author_updated_idx').on(t.authorUserId, t.bitbucketUpdatedAt),
  }),
);

// ---------------------------------------------------------------------------
// Sync bookkeeping
// ---------------------------------------------------------------------------

// One row per tracked repository. Holds the commit-pull cursor + outcome of
// the last commit-sync attempt (the `last_seen_sha` / `last_sync_*` columns)
// and, from Phase 4 T22, the PR-pull cursor + counter. Commit and PR ingest
// run on independent schedules and write disjoint columns, so they don't
// stomp on each other. Manual, cron, and webhook triggers all converge on
// the same row — see runSync() in src/sync/runner.ts.
export const syncState = bbstatSchema.table('sync_state', {
  repositoryId: integer('repository_id')
    .primaryKey()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  lastSeenSha: text('last_seen_sha'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
  lastSyncStatus: syncStatusEnum('last_sync_status').notNull().default('idle'),
  lastSyncError: text('last_sync_error'),
  totalCommitsSynced: integer('total_commits_synced').notNull().default(0),
  // Phase 4 T22: PR-sync cursor. PRs are walked newest-first by
  // `updated_on`; the cursor stores the most-recent `updated_on` we've
  // ingested and the BB-side numeric PR id for tie-break when multiple PRs
  // share the same second. NULL on both = cold mode (no prior PR sync).
  // `pr_last_synced_at` records when the PR sync last ran for this repo
  // (purely observational — no status enum since PR errors land in the
  // tick result + logs, not on the row).
  lastPrUpdatedAt: timestamp('last_pr_updated_at', { withTimezone: true }),
  lastPrId: integer('last_pr_id'),
  prLastSyncedAt: timestamp('pr_last_synced_at', { withTimezone: true }),
  prTotalSynced: integer('pr_total_synced').notNull().default(0),
  // Self-queueing deepen-backfill (Phase 4 follow-up). `deepen_complete`
  // flips to true once we've walked the repo's history all the way back to
  // its first commit (BB returns no `next` URL on the deepen pagination).
  // Until then the per-tick deepen worker picks one repo at a time —
  // ORDER BY deepen_last_run_at NULLS FIRST — and runs one bounded
  // backfill page walking backwards from the oldest known commit. This is
  // a derived queue: nothing to enqueue / dequeue, just SELECT from
  // sync_state on each tick.
  deepenComplete: boolean('deepen_complete').notNull().default(false),
  deepenLastRunAt: timestamp('deepen_last_run_at', { withTimezone: true }),
  // Retroactive `is_merge` backfill state. The `commits.is_merge` column
  // was added in migration V1_7 with DEFAULT false, so rows inserted
  // before that migration are stuck at false regardless of BB's actual
  // `parents.length`. New commits land with the correct value (both the
  // forward sync in commits.ts and the deepen-backfill walk in
  // deepen-backfill.ts read parents at insert time), so this state
  // exists purely to drain the pre-V1_7 backlog. The is-merge backfill
  // tick walks BB `/commits` newest-first, resuming from
  // `is_merge_backfill_cursor_sha` (NULL = start from newest), and
  // bulk-UPDATEs is_merge by sha via `updateIsMergeBatch`. When the
  // paginator exhausts without hitting the per-tick page cap, the
  // backfill is complete and `is_merge_backfill_complete` flips to
  // true; the repo drops out of the queue. Round-robin rotation via
  // `is_merge_last_run_at` mirrors the deepen worker. New repos enter
  // with `is_merge_backfill_complete = false` and converge after one
  // pass (every walked row already has the correct value, so
  // `updateIsMergeBatch` is a no-op).
  isMergeBackfillComplete: boolean('is_merge_backfill_complete').notNull().default(false),
  isMergeBackfillCursorSha: text('is_merge_backfill_cursor_sha'),
  isMergeLastRunAt: timestamp('is_merge_last_run_at', { withTimezone: true }),
  // Anonymous-commit sweep state. Standalone runner (entry point
  // `apps/backend/src/anonymous-sweep-main.ts`, `make dev-resync`)
  // walks BB `/commits` per repo to attribute commits whose
  // `author_user_id IS NULL` — typically ex-employees / never-members
  // whose UUIDs weren't in our users table at original ingest.
  // `anonymous_sweep_complete` flips to true once a sweep pass for
  // a repo attributes zero rows (everything attributable has been
  // attributed; the residual is structurally anonymous, e.g. BB lacks
  // a UUID or the email is unparseable). Picker filters out complete
  // repos via `ORDER BY anonymous_sweep_last_run_at NULLS FIRST` and
  // `WHERE anonymous_sweep_complete = false`, same shape as the
  // deepen / is-merge rotation. Independent of `dev-sync`'s cron —
  // operator runs `make dev-resync` once to drain the backlog and
  // it exits cleanly when done. To re-arm a repo (e.g. after adding
  // ex-employee accounts back to the workspace), manually UPDATE
  // the flag to false.
  anonymousSweepComplete: boolean('anonymous_sweep_complete').notNull().default(false),
  anonymousSweepLastRunAt: timestamp('anonymous_sweep_last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
