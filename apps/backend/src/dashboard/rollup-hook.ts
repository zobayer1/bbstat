// Wraps the per-repo commit sync with a post-success rollup-recompute step.
// Wired into the tick orchestrator via runner.ts → CommitsTickDeps.syncOne.
//
// Rollup failures NEVER poison the commit-sync result: the commits already
// landed in `commits` successfully, and the next sync of this repo will
// re-aggregate the same day range anyway (since recompute is scoped to the
// touched window). A failure here is a dashboard-freshness blip, not a
// data-integrity issue — log and move on.

import type { BitbucketLogger } from '../bitbucket/client.js';
import type { CommitSyncDeps, CommitSyncOptions, RepoCommitSyncResult, RepositoryHandle } from '../sync/commits.js';
import type { RollupStore } from './rollup-store.js';

export interface RollupHookDeps {
  rollupStore: RollupStore;
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
    return result;
  };
}
