// Retroactive `is_merge` backfill tick. Drains the pre-V1_7 backlog of
// commit rows whose `is_merge` column is stuck at false because the
// migration set the default to false on already-ingested rows. New
// commits land with the correct value (forward sync in commits.ts and
// the deepen-backfill walk both read `parents.length > 1` at insert
// time), so this tick exists purely to fix history.
//
// Priority placement, sharing the same hourly BB-call budget:
//
//   commit tick → deepen tick → IS-MERGE BACKFILL → diff-stats backfill
//
// Higher than diff-stats backfill (per-commit merge correctness gates
// every merge-excluding aggregate, including the diff-stat sums), lower
// than deepen (deepen extends coverage of unknown history; is-merge
// only corrects known rows).
//
// Per repo, per tick:
//   * pick one with `is_merge_backfill_complete = false` (round-robin
//     by `is_merge_last_run_at`)
//   * walk BB /commits — newest-first if cursor is NULL, else
//     `include=<cursorSha>` resuming where the last tick stopped
//   * collect {sha, isMerge} pairs up to maxPages × 100 commits
//   * bulk-UPDATE `is_merge` via the existing updateIsMergeBatch
//   * if the paginator exhausted → flip `is_merge_backfill_complete`
//   * if the page cap fired → advance the cursor to the oldest sha
//     we just walked; resume next tick
//
// Failure modes mirror deepen-backfill:
//   * BitbucketRateLimitError → tick-wide stop, repo stays incomplete,
//     remaining queue defers to the next cron firing.
//   * BB 404 (cursor sha rewritten / repo renamed) → mark complete
//     and log. Operator can flip the flag back via SQL if they want
//     to retry after re-resolving the cursor.
//   * Transient (any other error) → log, return empty result,
//     `markIsMergeBackfillAttempt` already bumped the rotation so the
//     next pick rotates to a different repo. Same row will be retried
//     after the round-robin comes back around.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits, type BitbucketCommit } from '../bitbucket/commits.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore } from './commit-store.js';

export interface IsMergeBackfillOptions {
  // Max pages of 100 commits per tick per repo. Same shape as the
  // deepen cap so operators have one mental model for both.
  maxPages: number;
  // Headroom required under BITBUCKET_HOURLY_CALL_BUDGET before the
  // orchestrator schedules another repo. Higher than the diff-stats
  // backfill threshold so is-merge gets first crack at leftover budget
  // after deepen, lower than the deepen threshold itself so deepen
  // still gets priority.
  budgetThreshold: number;
}

export interface IsMergeBackfillRepoResult {
  repositoryId: number;
  fullName: string;
  // Total commits walked this run. ≤ maxPages × 100.
  fetched: number;
  // Rows whose `is_merge` actually changed (already-correct rows are
  // no-ops thanks to the `IS DISTINCT FROM` filter in
  // `updateIsMergeBatch`). Most ticks on a repo whose backlog has
  // already been worked will be zero.
  updated: number;
  // True iff BB's paginated walk produced no `next` URL on the final
  // page — we've verified every commit. `is_merge_backfill_complete`
  // flips true.
  reachedRoot: boolean;
  // True iff the per-tick page cap fired before BB ran out of pages.
  // Cursor advanced; more work remains for the next tick.
  hitPageCap: boolean;
  // True iff the resume cursor 404'd (force-pushed history). Treated
  // as "give up on this repo" — `is_merge_backfill_complete` is set
  // so the rotation drops it.
  seedMissing: boolean;
  // True iff BB rate-limited us *and* the client exhausted its
  // in-request retry budget. The tick orchestrator treats this as a
  // tick-wide signal to stop, mirroring deepen.
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
  // outcomes. Failing to do this re-picks the same repo every tick.
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
      // Either the cursor sha was force-pushed out, or the repo
      // itself 404'd. Either way, the resume can never succeed —
      // mark complete and log. The exclusion auto-trip (step 4 in
      // the plan) will handle the repo-level 404 separately.
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
  // Per-repo results in the order processed.
  repos: IsMergeBackfillRepoResult[];
  // 'queue-empty' = every non-archived non-excluded repo has the flag
  // set — the gate the diff-stats auto-opt-in waits on. Other values
  // mean there's still incomplete work.
  stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete';
  budgetRemainingAtEnd: number;
  totalUpdated: number;
  totalFetched: number;
}

// Drains the queue until either (a) the call budget falls below
// `budgetThreshold`, (b) every queue-eligible repo is complete, or
// (c) BB rate-limits hard enough to exhaust the client's in-request
// retries. Many repos per tick — at curated-set scale most small
// repos finish in one tick.
export async function runIsMergeBackfillTick(
  deps: IsMergeBackfillDeps,
  opts: IsMergeBackfillOptions,
): Promise<IsMergeBackfillTickResult> {
  const repos: IsMergeBackfillRepoResult[] = [];
  // Stop after a full rotation through the incomplete set. Same
  // protection as deepen — guards against the pathological case where
  // a transient-error repo keeps reappearing at the head of the queue
  // because its `last_run_at` keeps getting bumped but no other
  // progress happens.
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
