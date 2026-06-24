// Wraps per-repo commit sync with post-success dashboard upkeep:
// (1) recompute commit_daily for the touched day range, then
// (2) invalidate user-summary cache entries for users whose commits landed.
//
// Neither side effect can poison the commit-sync result: commits already
// landed and the next sync re-aggregates the same window. Failures here are
// freshness blips, not data-integrity issues — log and move on.
//
// Ordering matters: recompute MUST run before invalidate. Otherwise a
// concurrent read between invalidate and recompute refills the cache from a
// still-stale rollup, holding stale data until the TTL elapses.

import type { BitbucketLogger } from '../bitbucket/client.js';
import type { CommitSyncDeps, CommitSyncOptions, RepoCommitSyncResult, RepositoryHandle } from '../sync/commits.js';
import type { RollupStore } from './rollup-store.js';
import type { UserSummaryCache } from './user-summary-cache.js';

export interface RollupHookDeps {
  rollupStore: RollupStore;
  userSummaryCache?: UserSummaryCache;
  logger?: BitbucketLogger;
}

export type SyncOneFn = (
  deps: CommitSyncDeps,
  repo: RepositoryHandle,
  opts: CommitSyncOptions,
) => Promise<RepoCommitSyncResult>;

export function withRollupRecompute(inner: SyncOneFn, hookDeps: RollupHookDeps): SyncOneFn {
  return async (deps, repo, opts) => {
    const result = await inner(deps, repo, opts);
    // Refresh the rollup whenever any dimension changed: new commits landed,
    // diff stats landed, or author_user_id transitioned NULL→known (BB linked
    // a member to a previously anonymous commit). The reattribution case is
    // load-bearing: without it the new attributed row would coexist with the
    // old anonymous (day, repo, NULL) row and the dashboard would double-count.
    const insertedRange = result.inserted > 0 ? result.insertedRange : null;
    const diffStatsRange = result.diffStatsUpdated > 0 ? result.diffStatsRange : null;
    const reattributedRange = result.reattributedRange;
    const range = mergeDayRanges(mergeDayRanges(insertedRange, diffStatsRange), reattributedRange);
    if (range === null) {
      return result;
    }
    try {
      const { rowsAffected } = await hookDeps.rollupStore.recomputeCommitDailyForRepo(result.repositoryId, range);
      hookDeps.logger?.info?.(
        {
          repositoryId: result.repositoryId,
          fullName: result.fullName,
          inserted: result.inserted,
          diffStatsUpdated: result.diffStatsUpdated,
          reattributed: result.reattributedRange !== null,
          range,
          rowsAffected,
        },
        'rollup recompute complete',
      );
    } catch (err) {
      hookDeps.logger?.warn?.(
        {
          repositoryId: result.repositoryId,
          fullName: result.fullName,
          range,
          err: err instanceof Error ? err.message : String(err),
        },
        'rollup recompute failed — commits already landed; will recover on next sync',
      );
    }
    if (hookDeps.userSummaryCache !== undefined) {
      try {
        const userIds = await hookDeps.rollupStore.listAffectedUserIdsForRepo(result.repositoryId, range);
        await Promise.all(userIds.map((id) => hookDeps.userSummaryCache!.invalidate(id)));
        hookDeps.logger?.info?.(
          {
            repositoryId: result.repositoryId,
            fullName: result.fullName,
            invalidatedUserCount: userIds.length,
          },
          'user-summary cache invalidated',
        );
      } catch (err) {
        hookDeps.logger?.warn?.(
          {
            repositoryId: result.repositoryId,
            fullName: result.fullName,
            range,
            err: err instanceof Error ? err.message : String(err),
          },
          'user-summary cache invalidation failed — entries will fall out via TTL',
        );
      }
    }
    return result;
  };
}

type DayRange = { sinceDay: string; untilDay: string };

// Union of two UTC day-range windows (inclusive on both ends). Day strings
// are YYYY-MM-DD so lexical compare matches chronological order.
function mergeDayRanges(a: DayRange | null, b: DayRange | null): DayRange | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return {
    sinceDay: a.sinceDay < b.sinceDay ? a.sinceDay : b.sinceDay,
    untilDay: a.untilDay > b.untilDay ? a.untilDay : b.untilDay,
  };
}
