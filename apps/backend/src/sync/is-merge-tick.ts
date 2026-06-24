// Retroactive `is_merge` backfill tick. Fixes the pre-V1_7 backlog of rows
// stuck at is_merge=false because the migration defaulted existing rows that
// way. New commits land with the correct value, so this tick only fixes
// history.
//
// Runs third in runCommitsSync (commit → deepen → is-merge → diff-stats):
// above diff-stats (merge correctness gates every merge-excluding aggregate),
// below deepen (deepen extends unknown history; is-merge only corrects known
// rows). Each tick picks one incomplete repo round-robin, walks /commits
// (resuming from the cursor), bulk-updates is_merge, then either marks
// complete or advances the cursor.
//
// Failure modes mirror deepen-backfill: rate-limit is a tick-wide stop; a
// 404 on the cursor sha marks complete (give up); any other error returns an
// empty result and rotation continues.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits, type BitbucketCommit } from '../bitbucket/commits.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore } from './commit-store.js';

export interface IsMergeBackfillOptions {
  // Max pages of 100 commits per tick per repo. Mirrors the deepen cap.
  maxPages: number;
  // Headroom required before scheduling another repo. Above the diff-stats
  // threshold (is-merge gets leftover budget first) but below deepen's.
  budgetThreshold: number;
}

export interface IsMergeBackfillRepoResult {
  repositoryId: number;
  fullName: string;
  fetched: number;
  // Rows whose `is_merge` actually changed (the IS DISTINCT FROM filter in
  // updateIsMergeBatch no-ops already-correct rows). Usually zero on a
  // worked-through repo.
  updated: number;
  // BB's walk produced no `next` URL — verified every commit.
  // is_merge_backfill_complete flips true.
  reachedRoot: boolean;
  // Page cap fired before BB ran out — cursor advanced, more remains.
  hitPageCap: boolean;
  // Resume cursor 404'd (force-pushed history). Give up: complete is set.
  seedMissing: boolean;
  // BB rate-limited AND retry budget exhausted — tick-wide stop, like deepen.
  rateLimited: boolean;
}

export interface IsMergeBackfillDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
}

// Single repo. Returns `null` only when the queue is empty. Transient
// errors return an empty result so the orchestrator loop can rotate.
// Budget gating is the orchestrator's responsibility.
export async function isMergeBackfillOneRepo(
  deps: IsMergeBackfillDeps,
  opts: IsMergeBackfillOptions,
): Promise<IsMergeBackfillRepoResult | null> {
  const candidate = await deps.store.pickRepoForIsMergeBackfill();
  if (candidate === null) return null;

  // Always bump last_run_at so the round-robin advances even on no-op
  // outcomes — otherwise we'd re-pick the same repo every tick.
  await deps.store.markIsMergeBackfillAttempt(candidate.repositoryId);

  const maxCommits = opts.maxPages * 100;
  const entries: Array<{ sha: string; isMerge: boolean }> = [];
  let oldestWalkedSha: string | null = null;
  let reachedRoot = false;
  let hitPageCap = false;
  let seedMissing = false;

  // BB returns the include= sha as the FIRST item — when resuming we
  // already verified it on the previous tick, so skip.
  let needToSkipSeed = candidate.cursorSha !== null;

  try {
    const iterOpts = candidate.cursorSha !== null ? { include: candidate.cursorSha } : {};
    for await (const commit of paginateCommits(deps.client, candidate.workspace, candidate.slug, iterOpts)) {
      if (needToSkipSeed && commit.hash === candidate.cursorSha) {
        needToSkipSeed = false;
        continue;
      }
      entries.push({ sha: commit.hash, isMerge: parentsIsMerge(commit) });
      oldestWalkedSha = commit.hash;
      if (entries.length >= maxCommits) {
        hitPageCap = true;
        break;
      }
    }
    if (!hitPageCap) reachedRoot = true;
  } catch (err) {
    if (err instanceof BitbucketRateLimitError) {
      deps.logger?.warn?.(
        {
          repositoryId: candidate.repositoryId,
          fullName: candidate.fullName,
          retryAfterSeconds: err.retryAfterSeconds,
        },
        'is-merge backfill: BB rate-limited — yielding remaining queue to next tick',
      );
      return {
        repositoryId: candidate.repositoryId,
        fullName: candidate.fullName,
        fetched: 0,
        updated: 0,
        reachedRoot: false,
        hitPageCap: false,
        seedMissing: false,
        rateLimited: true,
      };
    }
    if (err instanceof BitbucketApiError && err.status === 404) {
      // Cursor sha force-pushed out, or the repo itself 404'd — the resume
      // can never succeed, so mark complete. The commit-sync auto-trip
      // handles the repo-level 404 separately.
      seedMissing = true;
      reachedRoot = true;
      deps.logger?.warn?.(
        {
          repositoryId: candidate.repositoryId,
          fullName: candidate.fullName,
          cursorSha: candidate.cursorSha,
        },
        'is-merge backfill: 404 on cursor sha — marking complete',
      );
    } else {
      deps.logger?.error?.(err, `is-merge backfill: ${candidate.fullName} failed`);
      return {
        repositoryId: candidate.repositoryId,
        fullName: candidate.fullName,
        fetched: 0,
        updated: 0,
        reachedRoot: false,
        hitPageCap: false,
        seedMissing: false,
        rateLimited: false,
      };
    }
  }

  const { updated } =
    entries.length > 0 ? await deps.store.updateIsMergeBatch(candidate.repositoryId, entries) : { updated: 0 };

  if (reachedRoot) {
    await deps.store.markIsMergeBackfillComplete(candidate.repositoryId);
  } else if (hitPageCap && oldestWalkedSha !== null) {
    await deps.store.advanceIsMergeBackfillCursor(candidate.repositoryId, oldestWalkedSha);
  }

  deps.logger?.info?.(
    {
      repositoryId: candidate.repositoryId,
      fullName: candidate.fullName,
      fetched: entries.length,
      updated,
      reachedRoot,
      hitPageCap,
      seedMissing,
    },
    'is-merge backfill complete',
  );

  return {
    repositoryId: candidate.repositoryId,
    fullName: candidate.fullName,
    fetched: entries.length,
    updated,
    reachedRoot,
    hitPageCap,
    seedMissing,
    rateLimited: false,
  };
}

export interface IsMergeBackfillTickResult {
  repos: IsMergeBackfillRepoResult[];
  // 'queue-empty' = every eligible repo has the flag set, so the per-day
  // aggregates can now safely exclude merges across the whole tracked set.
  stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete';
  budgetRemainingAtEnd: number;
  totalUpdated: number;
  totalFetched: number;
}

// Drains the queue until budget falls below threshold, every eligible repo
// is complete, or BB rate-limits hard. Many repos per tick.
export async function runIsMergeBackfillTick(
  deps: IsMergeBackfillDeps,
  opts: IsMergeBackfillOptions,
): Promise<IsMergeBackfillTickResult> {
  const repos: IsMergeBackfillRepoResult[] = [];
  // Stop after a full rotation — guards the pathological case where a
  // transient-error repo keeps reappearing at the head because its
  // last_run_at is bumped but no progress happens. Same as deepen.
  const seen = new Set<number>();
  let stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete';
  for (;;) {
    if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
      stoppedReason = 'budget';
      deps.logger?.info?.(
        { remaining: deps.client.getBudgetRemaining(), threshold: opts.budgetThreshold, repos: repos.length },
        'is-merge backfill tick: budget gate fired',
      );
      break;
    }
    const result = await isMergeBackfillOneRepo(deps, opts);
    if (result === null) {
      stoppedReason = 'queue-empty';
      deps.logger?.info?.({ repos: repos.length }, 'is-merge backfill tick: queue drained');
      break;
    }
    if (seen.has(result.repositoryId)) {
      stoppedReason = 'rotation-complete';
      deps.logger?.info?.(
        { repos: repos.length, attempted: seen.size, repeatRepository: result.fullName },
        'is-merge backfill tick: full rotation completed',
      );
      break;
    }
    seen.add(result.repositoryId);
    repos.push(result);
    if (result.rateLimited) {
      stoppedReason = 'rate-limited';
      deps.logger?.info?.(
        { repos: repos.length, lastRepo: result.fullName },
        'is-merge backfill tick: yielded on BB rate limit',
      );
      break;
    }
  }
  return {
    repos,
    stoppedReason,
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
    totalUpdated: repos.reduce((acc, r) => acc + r.updated, 0),
    totalFetched: repos.reduce((acc, r) => acc + r.fetched, 0),
  };
}

function parentsIsMerge(commit: BitbucketCommit): boolean {
  return commit.parents.length > 1;
}
