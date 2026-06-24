// Storage interface for the `commit_daily` rollup, and its sole writer.
//
// `recomputeCommitDailyForRepo` is authoritative-for-the-window: DELETE every
// (day, repo, *) row in `[sinceDay, untilDay]`, then INSERT the freshly
// aggregated GROUP BY result, in one transaction. The earlier UPSERT-only path
// broke once `author_user_id` could transition NULL→known on re-sync: the
// GROUP BY then no longer produces a (day, repo, NULL) row, so UPSERT-only
// would leave the stale anonymous row in place and double-count the day. The
// DELETE pass fixes that, at one extra index scan per repo per tick.

import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';

// Inclusive on both ends. UTC-aligned `YYYY-MM-DD` strings — must match the
// day-bucket the rollup was built with (see migration V1_3 / 0002).
export interface DayRange {
  sinceDay: string;
  untilDay: string;
}

export interface RecomputeResult {
  rowsAffected: number;
}

export interface RollupStore {
  // Idempotent; safe to call with a wider range than strictly necessary.
  recomputeCommitDailyForRepo(repositoryId: number, range: DayRange): Promise<RecomputeResult>;

  // Distinct non-null author user IDs in the range — drives cache invalidation
  // so we only DEL Redis entries for users whose summaries actually changed.
  listAffectedUserIdsForRepo(repositoryId: number, range: DayRange): Promise<number[]>;

  // Full unscoped UPSERT — operator escape hatch for drift, via
  // `make rebuild-rollups`. Does NOT prune orphan rollup rows whose backing
  // commits were deleted out-of-band; the FK cascade from `repositories`
  // covers repo removals, leaving only manual `DELETE FROM commits` unhandled.
  rebuildAll(): Promise<RecomputeResult>;
}

export function createDrizzleRollupStore(db: Database): RollupStore {
  return {
    async recomputeCommitDailyForRepo(repositoryId, { sinceDay, untilDay }) {
      // DELETE the window then INSERT, in one transaction so reads never see
      // the intermediate "deleted but not yet rebuilt" state.
      //
      // Merge-commit split: commit_count / additions / deletions exclude merges
      // (FILTER WHERE NOT is_merge) so user-level aggregates don't double-
      // attribute merge churn to the merge author; merge_commit_count is the
      // counterpart for repo-level displays. See schema.ts on commit_daily.
      return await db.transaction(async (tx) => {
        await tx.execute(sql`
          DELETE FROM commit_daily
          WHERE repository_id = ${repositoryId}
            AND day BETWEEN ${sinceDay}::date AND ${untilDay}::date
        `);
        const result = await tx.execute(sql`
          INSERT INTO commit_daily (
            day, repository_id, author_user_id,
            commit_count, merge_commit_count, additions, deletions, updated_at
          )
          SELECT
            (date_trunc('day', authored_at AT TIME ZONE 'UTC'))::date AS day,
            repository_id,
            author_user_id,
            count(*) FILTER (WHERE NOT is_merge)::int AS commit_count,
            count(*) FILTER (WHERE is_merge)::int AS merge_commit_count,
            COALESCE(sum(additions) FILTER (WHERE NOT is_merge), 0)::int AS additions,
            COALESCE(sum(deletions) FILTER (WHERE NOT is_merge), 0)::int AS deletions,
            now()
          FROM commits
          WHERE repository_id = ${repositoryId}
            AND (date_trunc('day', authored_at AT TIME ZONE 'UTC'))::date BETWEEN ${sinceDay}::date AND ${untilDay}::date
          GROUP BY 1, 2, 3
        `);
        return { rowsAffected: result.rowCount ?? 0 };
      });
    },

    async listAffectedUserIdsForRepo(repositoryId, { sinceDay, untilDay }) {
      const rows = await db.execute<{ author_user_id: number }>(sql`
        SELECT DISTINCT author_user_id
        FROM commits
        WHERE repository_id = ${repositoryId}
          AND (date_trunc('day', authored_at AT TIME ZONE 'UTC'))::date BETWEEN ${sinceDay} AND ${untilDay}
          AND author_user_id IS NOT NULL
      `);
      return rows.rows.map((r) => r.author_user_id);
    },

    async rebuildAll() {
      // Same aggregate shape as `recomputeCommitDailyForRepo` (see the
      // merge-split rationale there) but unscoped, with ON CONFLICT DO
      // UPDATE so drifted rows get fixed in place.
      const result = await db.execute(sql`
        INSERT INTO commit_daily (
          day, repository_id, author_user_id,
          commit_count, merge_commit_count, additions, deletions, updated_at
        )
        SELECT
          (date_trunc('day', authored_at AT TIME ZONE 'UTC'))::date AS day,
          repository_id,
          author_user_id,
          count(*) FILTER (WHERE NOT is_merge)::int AS commit_count,
          count(*) FILTER (WHERE is_merge)::int AS merge_commit_count,
          COALESCE(sum(additions) FILTER (WHERE NOT is_merge), 0)::int AS additions,
          COALESCE(sum(deletions) FILTER (WHERE NOT is_merge), 0)::int AS deletions,
          now()
        FROM commits
        GROUP BY 1, 2, 3
        ON CONFLICT ON CONSTRAINT commit_daily_day_repo_user_unique DO UPDATE SET
          commit_count = EXCLUDED.commit_count,
          merge_commit_count = EXCLUDED.merge_commit_count,
          additions = EXCLUDED.additions,
          deletions = EXCLUDED.deletions,
          updated_at = now()
      `);
      return { rowsAffected: result.rowCount ?? 0 };
    },
  };
}
