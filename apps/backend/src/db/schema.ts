import { pgTable, pgEnum, serial, text, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
export const repositories = pgTable('repositories', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  workspace: text('workspace').notNull(),
  project: text('project'),
  slug: text('slug').notNull(),
  fullName: text('full_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shaRepoIdx: index('commits_sha_repo_idx').on(t.repositoryId, t.sha),
    authorAuthoredIdx: index('commits_author_authored_idx').on(t.authorUserId, t.authoredAt),
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

// One row per tracked repository. Holds the commit-pull cursor and the
// outcome of the last sync attempt. Manual, cron, and webhook triggers all
// converge on the same row — see runSync() in src/sync/runner.ts.
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
