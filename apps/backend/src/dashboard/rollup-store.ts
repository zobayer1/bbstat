// Storage interface for the `commit_daily` rollup. Mirrors the
// commit-store / discovery-store pattern: domain code (sync hook, future
// admin re-aggregate trigger) depends on the interface so tests can inject
// a fake without spinning up Postgres.
//
// Sole writer to commit_daily: this module. The sync runner calls
// `recomputeCommitDailyForRepo` once per repo per tick (after commits land),
// scoped to the touched day range. Steady state on an inserts-only commits
// table makes ON CONFLICT DO UPDATE sufficient — no DELETE pass needed —
// and the operation is idempotent against re-runs.

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
  // Re-aggregate `commit_daily` for the given repo across `[sinceDay, untilDay]`.
  // Pulls the latest counts from `commits`, UPSERTs into `commit_daily` keyed
  // on (day, repo, author_user_id). Idempotent; safe to call with a wider
  // range than strictly necessary.
  recomputeCommitDailyForRepo(repositoryId: number, range: DayRange): Promise<RecomputeResult>;

  // Distinct non-null `author_user_id` values for commits in `[sinceDay, untilDay]`
  // on the given repo. Used by the cache-invalidation hook so we only DEL
  // Redis entries for users whose summaries actually changed.
  listAffectedUserIdsForRepo(repositoryId: number, range: DayRange): Promise<number[]>;
}

export function createDrizzleRollupStore(db: Database): RollupStore {
  return {
    async recomputeCommitDailyForRepo(repositoryId, { sinceDay, untilDay }) {
      // One statement: aggregate from `commits` over the day window, then
      // UPSERT into `commit_daily`. The NULLS NOT DISTINCT constraint
      // collapses anonymous-author commits to a single (day, repo, NULL) row.
      const result = await db.execute(sql`
        INSERT INTO commit_daily (day, repository_id, author_user_id, commit_count, additions, deletions, updated_at)
        SELECT
          (date_trunc('day', authored_at AT TIME ZONE 'UTC'))::date AS day,
          repository_id,
          author_user_id,
          count(*)::int,
          sum(additions)::int,
          sum(deletions)::int,
          now()
        FROM commits
        WHERE repository_id = ${repositoryId}
          AND (date_trunc('day', authored_at AT TIME ZONE 'UTC'))::date BETWEEN ${sinceDay} AND ${untilDay}
        GROUP BY 1, 2, 3
        ON CONFLICT ON CONSTRAINT commit_daily_day_repo_user_unique DO UPDATE SET
          commit_count = EXCLUDED.commit_count,
          additions = EXCLUDED.additions,
          deletions = EXCLUDED.deletions,
          updated_at = now()
      `);
      return { rowsAffected: result.rowCount ?? 0 };
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
  };
}
