// Per-commit diff-stat ingest — fetches /diffstat/:sha and persists
// additions / deletions / files_changed. Two call paths share this walker:
// inline-eager (forward, fed the just-inserted rows by
// syncRepositoryCommits) and backfill (backward, fed a global newest-first
// pickup by runDiffStatsBackfillTick).
//
// Resumability lives on `diff_stats_synced_at`: a successful fetch stamps
// now() so the next pickup skips it; a transient failure leaves it NULL to
// retry next tick. The loop continues past per-commit errors so one bad
// commit never blocks others.

import { getCommitDiffStat } from '../bitbucket/diff-stats.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import { DIFF_STATS_FAILURE_THRESHOLD, type CommitStore, type PendingDiffStatCommit } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';

export interface DiffStatsSyncOptions {
  // Headroom below the hourly budget; the loop stops scheduling new
  // commits below it and the rest is picked up next tick.
  budgetThreshold: number;
}

export interface DiffStatsSyncResult {
  updated: number;
  // Fetch failed; row stays pending (diff_stats_synced_at IS NULL).
  failed: number;
  // Pulled this tick but not processed (budget gate hit mid-batch).
  deferred: number;
  hitBudgetGate: boolean;
  // UTC day range over commits whose diff stats just landed; scopes the
  // commit_daily refresh. Null when nothing updated.
  diffStatsRange: { sinceDay: string; untilDay: string } | null;
}

export interface DiffStatsSyncDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
}

const EMPTY: DiffStatsSyncResult = {
  updated: 0,
  failed: 0,
  deferred: 0,
  hitBudgetGate: false,
  diffStatsRange: null,
};

// Inline-eager forward path. Fetches diff stats for an explicit list of
// commits — no DB pickup, no per-tick cap (caller decides the batch). The
// budget gate still applies so a fat batch can't blow the hourly cap.
export async function fetchDiffStatsForCommits(
  deps: DiffStatsSyncDeps,
  repo: RepositoryHandle,
  commits: PendingDiffStatCommit[],
  opts: { budgetThreshold: number },
): Promise<DiffStatsSyncResult> {
  if (commits.length === 0) return EMPTY;
  return walkAndPersist(deps, repo, commits, opts.budgetThreshold);
}

async function walkAndPersist(
  deps: DiffStatsSyncDeps,
  repo: RepositoryHandle,
  commits: PendingDiffStatCommit[],
  budgetThreshold: number,
): Promise<DiffStatsSyncResult> {
  let updated = 0;
  let failed = 0;
  let hitBudgetGate = false;
  let sinceDay: string | null = null;
  let untilDay: string | null = null;

  for (const commit of commits) {
    if (deps.client.getBudgetRemaining() < budgetThreshold) {
      hitBudgetGate = true;
      deps.logger?.warn?.(
        {
          repositoryId: repo.repositoryId,
          fullName: repo.fullName,
          remaining: deps.client.getBudgetRemaining(),
          threshold: budgetThreshold,
          deferred: commits.length - updated - failed,
        },
        'diff-stats sync: budget gate — deferring remaining commits',
      );
      break;
    }
    // Pre-emptive yield when the pacer is saturated: calling at the ceiling
    // (default 3.2 s/call) makes minimal progress and just produces 429s.
    // Throws RateLimitError so the orchestrator yields the whole tick, not
    // just this repo.
    if (deps.client.isPacingSaturated()) {
      deps.logger?.warn?.(
        {
          repositoryId: repo.repositoryId,
          fullName: repo.fullName,
          pacingMs: deps.client.getCurrentPacingMs(),
          deferred: commits.length - updated - failed,
        },
        'diff-stats sync: adaptive pacer saturated — yielding tick to next cron',
      );
      throw new BitbucketRateLimitError(`/repositories/${repo.workspace}/${repo.slug}/diffstat/${commit.sha}`, 0);
    }
    try {
      const stat = await getCommitDiffStat(
        deps.client,
        repo.workspace,
        repo.slug,
        commit.sha,
        repo.diffStatsExcludePatterns,
      );
      await deps.store.updateCommitDiffStats(commit.id, stat);
      updated++;
      // YYYY-MM-DD matching Postgres' UTC day bucketing, so the range we
      // hand back lines up with the rollup.
      const day = commit.authoredAt.toISOString().slice(0, 10);
      if (sinceDay === null || day < sinceDay) sinceDay = day;
      if (untilDay === null || day > untilDay) untilDay = day;
    } catch (err) {
      // Rate-limit-exhausted is a tick-wide stop, NOT a per-commit failure
      // — re-throw so runDiffStatsBackfillTick yields the queue to the next
      // cron firing rather than hammering BB with more 429s.
      if (err instanceof BitbucketRateLimitError) {
        throw err;
      }
      failed++;
      // Same failure-budget as the backfill tick: 555 weight 3 (crosses on
      // one strike), other failures weight 1. Incrementing the counter here
      // too keeps the give-up path consistent — otherwise a heavy commit
      // would fail inline-eager without counting, then fail again in
      // backfill, paying ~2× the BB calls.
      const is555 = err instanceof BitbucketApiError && err.status === 555;
      const weight = is555 ? DIFF_STATS_FAILURE_THRESHOLD : 1;
      const newCount = await deps.store.incrementDiffStatsFailure(commit.id, weight);
      if (newCount >= DIFF_STATS_FAILURE_THRESHOLD) {
        await deps.store.updateCommitDiffStats(commit.id, { additions: 0, deletions: 0, filesChanged: 0 });
        deps.logger?.warn?.(
          {
            repositoryId: repo.repositoryId,
            fullName: repo.fullName,
            sha: commit.sha,
            failureCount: newCount,
            err: err instanceof Error ? err.message : String(err),
          },
          is555
            ? 'diff-stats: BB compute timeout (555) — giving up on this commit'
            : 'diff-stats: failure threshold crossed — giving up on this commit',
        );
      } else {
        deps.logger?.warn?.(
          {
            repositoryId: repo.repositoryId,
            fullName: repo.fullName,
            sha: commit.sha,
            failureCount: newCount,
            threshold: DIFF_STATS_FAILURE_THRESHOLD,
            err: err instanceof Error ? err.message : String(err),
          },
          'diff-stats fetch failed — leaving commit pending for next tick',
        );
      }
    }
  }

  const diffStatsRange = sinceDay !== null && untilDay !== null ? { sinceDay, untilDay } : null;
  const deferred = commits.length - updated - failed;
  const logFields = {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    updated,
    failed,
    deferred,
    hitBudgetGate,
    diffStatsRange,
  };
  // No-op completions log at debug — they fire per repo per tick once a
  // repo has drained, which would saturate the log without signal.
  if (updated === 0 && failed === 0 && deferred === 0 && !hitBudgetGate) {
    deps.logger?.debug?.(logFields, 'diff-stats sync complete (idle)');
  } else {
    deps.logger?.info?.(logFields, 'diff-stats sync complete');
  }
  return { updated, failed, deferred, hitBudgetGate, diffStatsRange };
}
