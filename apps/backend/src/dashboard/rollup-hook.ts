// Wraps the per-repo commit sync with post-success dashboard upkeep:
// (1) recompute commit_daily for the touched day range, then
// (2) invalidate user-summary cache entries for users whose commits landed.
// Wired into the tick orchestrator via runner.ts → CommitsTickDeps.syncOne.
//
// Neither side effect can poison the commit-sync result: the commits already
// landed in `commits` successfully, and the next sync of this repo will
// re-aggregate the same day range anyway (since recompute is scoped to the
// touched window). Failures here are dashboard-freshness blips, not
// data-integrity issues — log and move on.
//
// Ordering matters: recompute MUST run before invalidate. Otherwise a
// concurrent read between invalidate and recompute would refill the cache
// from a still-stale rollup, holding stale data until the TTL elapses.

import type { BitbucketLogger } from '../bitbucket/client.js';
import type { CommitSyncDeps, CommitSyncOptions, RepoCommitSyncResult, RepositoryHandle } from '../sync/commits.js';
import type { RollupStore } from './rollup-store.js';
import type { UserSummaryCache } from './user-summary-cache.js';

export interface RollupHookDeps {
  rollupStore: RollupStore;
  // Optional. When wired, summaries for users with commits in the touched
  // day range get DEL'd from cache so the next read recomputes from the
  // fresh rollup. Absent in tests that don't care about cache invalidation.
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
    if (result.inserted === 0 || result.insertedRange === null) {
      return result;
    }
    try {
      const { rowsAffected } = await hookDeps.rollupStore.recomputeCommitDailyForRepo(
        result.repositoryId,
        result.insertedRange,
      );
      hookDeps.logger?.info?.(
        {
          repositoryId: result.repositoryId,
          fullName: result.fullName,
          inserted: result.inserted,
          range: result.insertedRange,
          rowsAffected,
        },
        'rollup recompute complete',
      );
    } catch (err) {
      hookDeps.logger?.warn?.(
        {
          repositoryId: result.repositoryId,
          fullName: result.fullName,
          range: result.insertedRange,
          err: err instanceof Error ? err.message : String(err),
        },
        'rollup recompute failed — commits already landed; will recover on next sync',
      );
    }
    if (hookDeps.userSummaryCache !== undefined) {
      try {
        const userIds = await hookDeps.rollupStore.listAffectedUserIdsForRepo(
          result.repositoryId,
          result.insertedRange,
        );
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
            range: result.insertedRange,
            err: err instanceof Error ? err.message : String(err),
          },
          'user-summary cache invalidation failed — entries will fall out via TTL',
        );
      }
    }
    return result;
  };
}
