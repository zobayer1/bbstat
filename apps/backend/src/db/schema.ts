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

// `repositories` represents the curated *tracked* set — only repos in this
// table are ingested by sync workers. Untracked repos in the workspace are
// simply absent. See docs/ROADMAP.md "Curated list growth".
//
// `diff_stats_enabled` is the Phase 4 opt-in for fetching per-commit additions
// / deletions via /diffstat/:sha. Authoritative source for the flag is the
// `repositories` row; `tracked-repos.yaml` writes through it on every
// discovery sync so toggling the YAML knob re-applies at the next tick.
export const repositories = pgTable('repositories', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  workspace: text('workspace').notNull(),
  project: text('project'),
  slug: text('slug').notNull(),
  fullName: text('full_name').notNull(),
  diffStatsEnabled: boolean('diff_stats_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// `diff_stats_synced_at` is the Phase 4 resumability marker for per-commit
// diff-stat ingest. NULL = "diff stats not fetched yet" (the only state at
// insertion time). Set to now() once /diffstat/:sha lands and additions /
// deletions are persisted. The partial index commits_pending_diff_stats_idx
// makes the pickup query (`WHERE repository_id = $1 AND diff_stats_synced_at
// IS NULL`) cheap regardless of how large `commits` grows.
//
// Repos with `repositories.diff_stats_enabled = false` simply never have the
// fetch happen — their rows stay at additions=0, deletions=0, NULL.
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
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
