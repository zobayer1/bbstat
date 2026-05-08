import { pgTable, serial, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  displayName: text('display_name').notNull(),
  username: text('username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
