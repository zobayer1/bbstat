// Storage interface for commit-ingest operations. Mirrors discovery-store:
// domain logic in commits.ts injects a CommitStore (real or fake) so it stays
// testable without spinning up Postgres.
//
// Idempotency: insertCommits uses ON CONFLICT DO NOTHING on the
// commits_sha_repo_unique constraint — re-running a sync that races another
// trigger never errors and never duplicates. The cursor helpers
// (getSyncState, markSync{Running,Success,Failed}) own the sync_state row
// lifecycle for a single repository.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commits, syncState, users } from '../db/schema.js';

export type SyncStatus = 'idle' | 'running' | 'success' | 'failed';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommitInsertInput {
  repositoryId: number;
  authorUserId: number | null;
  sha: string;
  message: string;
  authoredAt: Date;
}

export interface CommitInsertResult {
  inserted: number;
}

export interface SyncStateRow {
  repositoryId: number;
  lastSeenSha: string | null;
  lastSyncedAt: Date | null;
  lastSyncStartedAt: Date | null;
  lastSyncStatus: SyncStatus;
  lastSyncError: string | null;
  totalCommitsSynced: number;
}

export interface SyncSuccessUpdate {
  // null leaves the cursor untouched — used when a clean run produced no new
  // commits (idle repo) and we still want to record a successful tick.
  lastSeenSha: string | null;
  commitsAdded: number;
}

export interface PendingDiffStatCommit {
  id: number;
  sha: string;
  authoredAt: Date;
}

export interface CommitStore {
  // Resolve a batch of BitBucket user UUIDs to local users.id values. Missing
  // UUIDs (anonymous commits, users not yet synced) are absent from the
  // result map; callers translate that absence into author_user_id = null.
  resolveUserIdsByUuid(uuids: string[]): Promise<Map<string, number>>;

  // Bulk insert commits. Conflicts on (repository_id, sha) are skipped — commits
  // are immutable, so re-runs converge. Returns the count of newly inserted rows.
  insertCommits(input: CommitInsertInput[]): Promise<CommitInsertResult>;

  getSyncState(repositoryId: number): Promise<SyncStateRow | null>;
  markSyncRunning(repositoryId: number): Promise<void>;
  markSyncSuccess(repositoryId: number, update: SyncSuccessUpdate): Promise<void>;
  markSyncFailed(repositoryId: number, error: string): Promise<void>;

  // Phase 4 T21: pickup query for the diff-stats worker. Returns commits in
  // this repo whose `diff_stats_synced_at IS NULL`, ordered newest-authored
  // first (so the most recently-landed commits get their diffs prioritized)
  // and capped at `limit`. Backed by the partial index
  // commits_pending_diff_stats_idx so the read is cheap regardless of
  // total commit volume.
  listPendingDiffStatCommits(repositoryId: number, limit: number): Promise<PendingDiffStatCommit[]>;

  // Phase 4 T21: persist BB-derived additions/deletions for one commit and
  // stamp diff_stats_synced_at = now() so it's filtered out of the next
  // pickup. Idempotent — safe to call repeatedly with the same values.
  updateCommitDiffStats(commitId: number, input: { additions: number; deletions: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle-backed implementation
// ---------------------------------------------------------------------------

export function createDrizzleCommitStore(db: Database): CommitStore {
  return {
    async resolveUserIdsByUuid(uuids) {
      if (uuids.length === 0) return new Map();
      const rows = await db
        .select({ id: users.id, uuid: users.bitbucketUuid })
        .from(users)
        .where(inArray(users.bitbucketUuid, uuids));
      return new Map(rows.map((r) => [r.uuid, r.id]));
    },

    async insertCommits(input) {
      if (input.length === 0) return { inserted: 0 };
      const result = await db
        .insert(commits)
        .values(input)
        .onConflictDoNothing({ target: [commits.repositoryId, commits.sha] })
        .returning({ id: commits.id });
      return { inserted: result.length };
    },

    async getSyncState(repositoryId) {
      const rows = await db
        .select({
          repositoryId: syncState.repositoryId,
          lastSeenSha: syncState.lastSeenSha,
          lastSyncedAt: syncState.lastSyncedAt,
          lastSyncStartedAt: syncState.lastSyncStartedAt,
          lastSyncStatus: syncState.lastSyncStatus,
          lastSyncError: syncState.lastSyncError,
          totalCommitsSynced: syncState.totalCommitsSynced,
        })
        .from(syncState)
        .where(eq(syncState.repositoryId, repositoryId))
        .limit(1);
      return rows[0] ?? null;
    },

    async markSyncRunning(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({
          lastSyncStartedAt: now,
          lastSyncStatus: 'running',
          updatedAt: now,
        })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async markSyncSuccess(repositoryId, update) {
      const now = new Date();
      // Atomic increment via SQL expression — concurrent ticks (cron + manual)
      // can both succeed without losing count to a read-modify-write race.
      const set = {
        lastSyncedAt: now,
        lastSyncStatus: 'success' as const,
        lastSyncError: null,
        updatedAt: now,
        ...(update.lastSeenSha !== null ? { lastSeenSha: update.lastSeenSha } : {}),
        ...(update.commitsAdded > 0
          ? { totalCommitsSynced: sql`${syncState.totalCommitsSynced} + ${update.commitsAdded}` }
          : {}),
      };
      await db.update(syncState).set(set).where(eq(syncState.repositoryId, repositoryId));
    },

    async markSyncFailed(repositoryId, error) {
      const now = new Date();
      await db
        .update(syncState)
        .set({
          lastSyncStatus: 'failed',
          lastSyncError: error,
          updatedAt: now,
        })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async listPendingDiffStatCommits(repositoryId, limit) {
      const rows = await db
        .select({ id: commits.id, sha: commits.sha, authoredAt: commits.authoredAt })
        .from(commits)
        .where(and(eq(commits.repositoryId, repositoryId), isNull(commits.diffStatsSyncedAt)))
        .orderBy(desc(commits.authoredAt))
        .limit(limit);
      return rows;
    },

    async updateCommitDiffStats(commitId, input) {
      await db
        .update(commits)
        .set({
          additions: input.additions,
          deletions: input.deletions,
          diffStatsSyncedAt: new Date(),
        })
        .where(eq(commits.id, commitId));
    },
  };
}
