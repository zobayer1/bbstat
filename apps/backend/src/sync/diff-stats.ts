// Per-commit diff-stat ingest — fetches /diffstat/:sha and persists
// additions / deletions / files_changed onto each commit row. Two call
// paths share the inner walker:
//
//   1. Inline-eager (forward path) — invoked by `syncRepositoryCommits`
//      right after `insertCommits` returns the newly-landed rows. We feed
//      those rows directly into `fetchDiffStatsForCommits`, so brand-new
//      commits get their stats with minimal lag and without a DB pickup.
//
//   2. Backfill (backward path) — invoked by `runDiffStatsBackfillTick`
//      after the deepen tick, lower priority than commit-list ingest.
//      That orchestrator does a single global newest-first pickup
//      across every non-archived non-excluded repo
//      (`commits.diff_stats_synced_at IS NULL`, ORDER BY
//      `commits.authored_at DESC`) and walks the resulting queue
//      directly — the per-repo `syncRepositoryDiffStats` wrapper that
//      used to live here was removed in 2026-05.
//
// Resumability lives on `diff_stats_synced_at`: a successful fetch +
// UPDATE stamps now(), so the next pickup query skips it. A transient
// failure (HTTP 5xx, network blip) leaves the row NULL → retried next
// tick. A persistent 4xx on a single commit will waste one BB call per
// tick until investigated, but won't block others since the loop
// continues past per-commit errors.
//
// Per-repo opt-in was removed in 2026-05; every non-archived
// non-excluded repo participates by default. The walker's only gate
// is now the empty-commits short-circuit in `fetchDiffStatsForCommits`.

import { getCommitDiffStat } from '../bitbucket/diff-stats.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore, PendingDiffStatCommit } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';

export interface DiffStatsSyncOptions {
  // Headroom below BITBUCKET_HOURLY_CALL_BUDGET. The loop stops scheduling
  // new commits once getBudgetRemaining() falls below this; remaining
  // pending commits are picked up on the next tick.
  budgetThreshold: number;
}

export interface DiffStatsSyncResult {
  // Commits whose diff stats were successfully fetched + persisted this run.
  updated: number;
  // Commits whose fetch failed and remain pending (diff_stats_synced_at IS NULL).
  failed: number;
  // Commits that were pulled from the pickup query this tick but not
  // processed before the walker bailed (budget gate hit mid-batch).
  // = pending.length - updated - failed. Surfaced for log clarity:
  // "this repo had work pending but couldn't drain it this tick."
  deferred: number;
  // True iff the budget gate fired and we stopped before draining the pickup.
  hitBudgetGate: boolean;
  // UTC day range covering every commit whose diff stats just landed. Consumed
  // by the rollup hook to scope the commit_daily refresh. Null when nothing
  // was successfully updated.
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
// commits (typically the ones just inserted by `syncRepositoryCommits`)
// — no DB pickup, no per-tick cap (caller decides how many rows to
// pass in). Budget gate still applies so a fat batch can't blow the
// hourly cap. Backfill path lives in diff-stats-tick.ts which uses a
// global newest-first pickup across the whole opted-in pool.
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
    // Pre-emptive yield when the adaptive pacer has fully saturated.
    // Continuing to call at the ceiling (default 3.2 s/call) makes minimal
    // progress and produces a stream of 429s — better to defer the
    // remaining commits to the next cron firing. Throws RateLimitError so
    // the orchestrator yields the whole tick (instead of just this repo),
    // mirroring the post-retry-exhaustion path.
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
      // YYYY-MM-DD of the commit's authored_at, matching Postgres'
      // `(date_trunc('day', x AT TIME ZONE 'UTC'))::date` exactly — same
      // bucketing the rollup uses, so the range we hand back lines up.
      const day = commit.authoredAt.toISOString().slice(0, 10);
      if (sinceDay === null || day < sinceDay) sinceDay = day;
      if (untilDay === null || day > untilDay) untilDay = day;
    } catch (err) {
      // Rate-limit-exhausted is a tick-wide stop signal, NOT a per-commit
      // failure. The BitbucketClient throws this only after pacing has
      // topped out (default 3200ms) AND BB still 429s through the
      // in-request retry budget — soldiering on to the next commit just
      // hammers BB and produces dozens more 429s per tick. Re-throw so
      // `runDiffStatsBackfillTick` can yield the queue to the next cron
      // firing, by which time BB's rolling window has rotated and the
      // pacer has had time to decay.
      if (err instanceof BitbucketRateLimitError) {
        throw err;
      }
      failed++;
      deps.logger?.warn?.(
        {
          repositoryId: repo.repositoryId,
          fullName: repo.fullName,
          sha: commit.sha,
          err: err instanceof Error ? err.message : String(err),
        },
        'diff-stats fetch failed — leaving commit pending for next tick',
      );
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
  // No-op completions (zero commits walked, zero rows updated/failed,
  // no budget gate fired) log at debug — they fire per opted-in repo
  // per backfill tick once a repo has fully drained, and at 26+
  // opted-in repos × 12 ticks/hr this saturates the log without signal.
  if (updated === 0 && failed === 0 && deferred === 0 && !hitBudgetGate) {
    deps.logger?.debug?.(logFields, 'diff-stats sync complete (idle)');
  } else {
    deps.logger?.info?.(logFields, 'diff-stats sync complete');
  }
  return { updated, failed, deferred, hitBudgetGate, diffStatsRange };
}
