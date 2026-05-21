// Storage interface for the `commit_daily` rollup. Mirrors the
// commit-store / discovery-store pattern: domain code (sync hook, future
// admin re-aggregate trigger) depends on the interface so tests can inject
// a fake without spinning up Postgres.
//
// Sole writer to commit_daily: this module. The sync runner calls
// `recomputeCommitDailyForRepo` once per repo per tick (after commits land),
// scoped to the touched day range. The recompute is authoritative-for-the-
// window: DELETE every (day, repo, *) row in `[sinceDay, untilDay]`, then
// INSERT the freshly aggregated GROUP BY result, both inside one
// transaction. The earlier "INSERT … ON CONFLICT DO UPDATE only" path
// assumed an inserts-only commits table — that broke once we allowed
// `author_user_id` to transition NULL → known on re-sync (BB linking a
// workspace member to a previously anonymous commit). After such a
// transition the GROUP BY no longer produces a (day, repo, NULL) row,
// so an UPSERT-only recompute would leave the stale anonymous row in
// place and double-count the day. The DELETE pass fixes that, at the
// cost of one extra index scan per repo per tick.

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

  // Full unscoped UPSERT — re-aggregates every (day, repo, user) bucket from
  // `commits` and writes through to `commit_daily`. Operator escape hatch for
  // drift; invoked via `make rebuild-rollups`. Does NOT prune orphan rollup
  // rows whose backing commits were deleted out-of-band; the FK cascade from
  // `repositories` covers repo removals, leaving only manual `DELETE FROM
  // commits …` as an unhandled edge.
  rebuildAll(): Promise<RecomputeResult>;
}

export function createDrizzleRollupStore(db: Database): RollupStore {
  return {
    async recomputeCommitDailyForRepo(repositoryId, { sinceDay, untilDay }) {
      // Authoritative rebuild for `[sinceDay, untilDay]`: DELETE the
      // window, then INSERT the freshly aggregated GROUP BY result.
      // Both statements run in one transaction so dashboard reads
      // never see the intermediate "window deleted but not yet
      // rebuilt" state. The NULLS NOT DISTINCT constraint on
      // `commit_daily_day_repo_user_unique` collapses anonymous-author
      // commits to a single (day, repo, NULL) row, same as before.
      //
      // Merge-commit split: `commit_count` and `additions` / `deletions`
      // exclude merges (FILTER WHERE NOT is_merge) — user-level
      // aggregates that read straight from commit_daily (Members
      // table, top-contributors panel, etc.) should never see merge
      // churn double-attributed to the click-the-merge-button author.
      // `merge_commit_count` is the merge counterpart for repo-level
      // activity displays that DO want to surface "this repo got a
      // merge today". See schema.ts comment on commit_daily.
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
