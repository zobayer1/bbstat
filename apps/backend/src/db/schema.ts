import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  serial,
  text,
  timestamp,
  date,
  integer,
  boolean,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const syncStatusEnum = pgEnum('sync_status', ['idle', 'running', 'success', 'failed']);

export const pullRequestStateEnum = pgEnum('pull_request_state', ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']);

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  displayName: text('display_name').notNull(),
  username: text('username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// `repositories` represents the curated *tracked* set — rows here that
// are not archived are what sync workers walk. `tracked-repos.yaml` is a
// **seed file**, not a live config source: it controls which repos get
// inserted on first discovery, and seeds the initial values of
// per-repo flags (`diff_stats_enabled`, `archived`). Once a row exists,
// the DB is canonical — admin endpoints / scripts / ad-hoc SQL update
// the flags, and subsequent discovery syncs do NOT overwrite them from
// YAML. See docs/ROADMAP.md "Curated list growth".
//
// `diff_stats_enabled` — Phase 4 opt-in for fetching per-commit
// additions / deletions / files_changed via /diffstat/:sha. Seeded from
// `{ name, diffStats: true }` in YAML; flipped at runtime via direct
// SQL (no admin endpoint for this flag yet).
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
// permanently-broken state: a 404 on the commits endpoint (the repo
// was renamed or deleted upstream), or an empty repo whose
// `deepen_complete = true` arrived with `total_commits_synced = 0`.
// Distinct column from `archived` so the UI can surface
// "needs attention" separately from operator-initiated retirement,
// and so a future admin recovery action (re-resolve / merge canonical
// row) has a dedicated lifecycle to attach to.
export const repositories = pgTable('repositories', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  workspace: text('workspace').notNull(),
  project: text('project'),
  slug: text('slug').notNull(),
  fullName: text('full_name').notNull(),
  diffStatsEnabled: boolean('diff_stats_enabled').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  syncExcluded: boolean('sync_excluded').notNull().default(false),
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
// alongside additions/deletions when the diff-stats step lands. Repos
// with `repositories.diff_stats_enabled = false` simply never have the
// fetch happen — their rows stay at additions=0, deletions=0,
// files_changed=0, diff_stats_synced_at=NULL.
export const commits = pgTable(
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
    diffStatsSyncedAt: timestamp('diff_stats_synced_at', { withTimezone: true }),
    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shaRepoUnique: uniqueIndex('commits_sha_repo_unique').on(t.repositoryId, t.sha),
    authorAuthoredIdx: index('commits_author_authored_idx').on(t.authorUserId, t.authoredAt),
    pendingDiffStatsIdx: index('commits_pending_diff_stats_idx')
      .on(t.repositoryId)
      .where(sql`${t.diffStatsSyncedAt} IS NULL`),
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
export const commitDaily = pgTable(
  'commit_daily',
  {
    day: date('day').notNull(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    commitCount: integer('commit_count').notNull().default(0),
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

export const branches = pgTable(
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

export const pullRequests = pgTable(
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
export const syncState = pgTable('sync_state', {
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
