// Storage interface for PR-ingest operations. Sibling of commit-store.ts;
// both touch the `sync_state` table but write disjoint columns, so they
// don't interfere. The domain code in `pull-requests.ts` consumes this
// interface (real or fake) to stay testable without spinning up Postgres.
//
// Idempotency: upsertPullRequests does INSERT ... ON CONFLICT DO UPDATE on
// the (repository_id, bitbucket_pr_id) unique index — re-ingesting the same
// PR is safe and overwrites the row with the latest state/title/comment
// counts. The cursor helpers own the PR-cursor fields on the sync_state row
// (last_pr_updated_at, last_pr_id, pr_last_synced_at, pr_total_synced).

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { pullRequests, syncState, users } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  // null leaves the cursor untouched — used when a clean run produced
  // no new PRs (idle repo). Otherwise stores the head of the just-pulled
  // batch (BB returns newest-first when sorted by `-updated_on`).
  newCursor: { updatedAt: Date; prId: number } | null;
  // Total rows persisted by the run (inserted + updated). Used for the
  // atomic `pr_total_synced + n` bump so concurrent ticks (cron + manual)
  // can't lose count to read-modify-write.
  addedOrUpdated: number;
}

export interface PrStore {
  // Same shape + semantics as CommitStore.resolveUserIdsByUuid. Duplicated
  // here so PrStore stays independent of CommitStore — the SQL is trivial
  // and a shared "user lookup" abstraction would only pay off if a third
  // sync surface appears.
  resolveUserIdsByUuid(uuids: string[]): Promise<Map<string, number>>;

  // Bulk upsert. Inserts go in fresh; conflicts on
  // (repository_id, bitbucket_pr_id) update the mutable columns (title,
  // state, comment_count, task_count, bitbucket_updated_at, etc.) so PR
  // state transitions (OPEN → MERGED, comment churn) land at the next sync.
  // All input rows must share the same repository_id — the sync function
  // gathers PRs from one repo's BB endpoint per call.
  upsertPullRequests(input: PullRequestInsertInput[]): Promise<PullRequestUpsertResult>;

  getPrSyncState(repositoryId: number): Promise<PrSyncStateRow | null>;
  markPrSyncSuccess(repositoryId: number, update: PrSyncSuccessUpdate): Promise<void>;
}

// ---------------------------------------------------------------------------
// Drizzle-backed implementation
// ---------------------------------------------------------------------------

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
      // Pre-flight SELECT to attribute the upsert results to inserts vs.
      // updates. The DB rows themselves are correct either way (ON CONFLICT
      // DO UPDATE handles both), so a brief race where another tick inserts
      // between this SELECT and the INSERT can only misreport the *counts*
      // — never the data. Counts are advisory (logs / response body), not
      // load-bearing.
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
