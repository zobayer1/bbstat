// Storage interface for PR-ingest operations. Sibling of commit-store.ts;
// both write disjoint columns of `sync_state`, so they don't interfere.
//
// Idempotency: upsertPullRequests is ON CONFLICT DO UPDATE on
// (repository_id, bitbucket_pr_id) — re-ingesting a PR overwrites it with
// the latest state/title/comment counts.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { pullRequests, syncState, users } from '../db/schema.js';

export type PullRequestState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';

export interface PullRequestInsertInput {
  repositoryId: number;
  bitbucketPrId: number;
  title: string;
  state: PullRequestState;
  authorUserId: number | null;
  sourceBranch: string;
  destinationBranch: string;
  sourceSha: string | null;
  destinationSha: string | null;
  commentCount: number;
  taskCount: number;
  bitbucketCreatedAt: Date;
  bitbucketUpdatedAt: Date;
  bitbucketClosedAt: Date | null;
}

export interface PullRequestUpsertResult {
  inserted: number;
  updated: number;
}

export interface PrSyncStateRow {
  repositoryId: number;
  lastPrUpdatedAt: Date | null;
  lastPrId: number | null;
  prLastSyncedAt: Date | null;
  prTotalSynced: number;
}

export interface PrSyncSuccessUpdate {
  // null leaves the cursor untouched (idle repo). Otherwise the head of the
  // just-pulled batch (BB returns newest-first sorted by `-updated_on`).
  newCursor: { updatedAt: Date; prId: number } | null;
  // Rows persisted this run. Drives the atomic `pr_total_synced + n` bump so
  // concurrent ticks can't lose count to read-modify-write.
  addedOrUpdated: number;
}

export interface PrStore {
  // Same as CommitStore.resolveUserIdsByUuid; duplicated so PrStore stays
  // independent (the SQL is trivial).
  resolveUserIdsByUuid(uuids: string[]): Promise<Map<string, number>>;

  // Bulk upsert. Conflicts on (repository_id, bitbucket_pr_id) update the
  // mutable columns so state transitions (OPEN → MERGED, comment churn) land
  // next sync. All input rows must share one repository_id.
  upsertPullRequests(input: PullRequestInsertInput[]): Promise<PullRequestUpsertResult>;

  getPrSyncState(repositoryId: number): Promise<PrSyncStateRow | null>;
  markPrSyncSuccess(repositoryId: number, update: PrSyncSuccessUpdate): Promise<void>;
}

export function createDrizzlePrStore(db: Database): PrStore {
  return {
    async resolveUserIdsByUuid(uuids) {
      if (uuids.length === 0) return new Map();
      const rows = await db
        .select({ id: users.id, uuid: users.bitbucketUuid })
        .from(users)
        .where(inArray(users.bitbucketUuid, uuids));
      return new Map(rows.map((r) => [r.uuid, r.id]));
    },

    async upsertPullRequests(input) {
      if (input.length === 0) return { inserted: 0, updated: 0 };
      // Pre-flight SELECT only to split the result into inserted vs. updated
      // counts. A race between this SELECT and the INSERT can misreport the
      // counts but never the data — counts are advisory.
      const repositoryId = input[0]!.repositoryId;
      const ids = input.map((i) => i.bitbucketPrId);
      const existing = await db
        .select({ id: pullRequests.bitbucketPrId })
        .from(pullRequests)
        .where(and(eq(pullRequests.repositoryId, repositoryId), inArray(pullRequests.bitbucketPrId, ids)));
      const existingIds = new Set(existing.map((r) => r.id));

      await db
        .insert(pullRequests)
        .values(input)
        .onConflictDoUpdate({
          target: [pullRequests.repositoryId, pullRequests.bitbucketPrId],
          set: {
            title: sql`excluded.title`,
            state: sql`excluded.state`,
            authorUserId: sql`excluded.author_user_id`,
            sourceBranch: sql`excluded.source_branch`,
            destinationBranch: sql`excluded.destination_branch`,
            sourceSha: sql`excluded.source_sha`,
            destinationSha: sql`excluded.destination_sha`,
            commentCount: sql`excluded.comment_count`,
            taskCount: sql`excluded.task_count`,
            bitbucketCreatedAt: sql`excluded.bitbucket_created_at`,
            bitbucketUpdatedAt: sql`excluded.bitbucket_updated_at`,
            bitbucketClosedAt: sql`excluded.bitbucket_closed_at`,
            syncedAt: sql`now()`,
          },
        });

      return {
        inserted: input.length - existingIds.size,
        updated: existingIds.size,
      };
    },

    async getPrSyncState(repositoryId) {
      const rows = await db
        .select({
          repositoryId: syncState.repositoryId,
          lastPrUpdatedAt: syncState.lastPrUpdatedAt,
          lastPrId: syncState.lastPrId,
          prLastSyncedAt: syncState.prLastSyncedAt,
          prTotalSynced: syncState.prTotalSynced,
        })
        .from(syncState)
        .where(eq(syncState.repositoryId, repositoryId))
        .limit(1);
      return rows[0] ?? null;
    },

    async markPrSyncSuccess(repositoryId, update) {
      const now = new Date();
      const set = {
        prLastSyncedAt: now,
        updatedAt: now,
        ...(update.newCursor !== null
          ? {
              lastPrUpdatedAt: update.newCursor.updatedAt,
              lastPrId: update.newCursor.prId,
            }
          : {}),
        ...(update.addedOrUpdated > 0
          ? { prTotalSynced: sql`${syncState.prTotalSynced} + ${update.addedOrUpdated}` }
          : {}),
      };
      await db.update(syncState).set(set).where(eq(syncState.repositoryId, repositoryId));
    },
  };
}
