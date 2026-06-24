// Diff-stats backfill tick — global newest-first pickup.
//
// Drains pending diff-stat work (`commits.diff_stats_synced_at IS NULL`)
// across every non-archived non-excluded repo as one ordered queue, so a
// repo with 5000 pending commits can't monopolize a tick. Recent commits
// everywhere land first.
//
// Runs last in runCommitsSync (commit → deepen → is-merge → diff-stats), so
// it yields the shared hourly budget to the earlier steps.
//
// Failure modes: BitbucketRateLimitError and a saturated pacer are tick-wide
// stops — the pool waits for the next cron firing. A single-commit 4xx/5xx
// is failed++, continue; the row stays pending and retries next tick.

import { getCommitDiffStat } from '../bitbucket/diff-stats.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import { DIFF_STATS_FAILURE_THRESHOLD, type CommitStore } from './commit-store.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';

export interface DiffStatsBackfillTickOptions {
  // Max commits per tick, total across all repos. Caps burst size; steady
  // throughput is budget-limited, not capped by this.
  maxCommitsPerTick: number;
  // Headroom required under the hourly budget. Below it the loop bails and
  // the pool waits for the next tick.
  budgetThreshold: number;
}

export interface DiffStatsBackfillTickDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  rollupStore?: RollupStore;
  userSummaryCache?: UserSummaryCache;
}

// Per-repo summary of work this tick. Only repos with at least one commit
// processed appear. Drives the rollup recompute (one per non-empty entry).
export interface PerRepoDiffStatsResult {
  repositoryId: number;
  fullName: string;
  updated: number;
  failed: number;
  range: { sinceDay: string; untilDay: string } | null;
}

export interface DiffStatsBackfillTickResult {
  totalUpdated: number;
  // Per-commit failures that did NOT abort the tick; those rows stay pending.
  totalFailed: number;
  perRepo: PerRepoDiffStatsResult[];
  // null = drained cleanly. 'budget' = budget gate. 'rate-limited' = retry
  // budget exhausted or pacer saturated.
  stopReason: 'budget' | 'rate-limited' | null;
  budgetRemainingAtEnd: number;
}

export async function runDiffStatsBackfillTick(
  deps: DiffStatsBackfillTickDeps,
  opts: DiffStatsBackfillTickOptions,
): Promise<DiffStatsBackfillTickResult> {
  const queue = await deps.store.listPendingDiffStatCommitsGlobal(opts.maxCommitsPerTick);
  if (queue.length === 0) {
    deps.logger?.info?.(
      { budgetRemaining: deps.client.getBudgetRemaining() },
      'diff-stats backfill: queue drained — nothing pending across tracked repos',
    );
    return {
      totalUpdated: 0,
      totalFailed: 0,
      perRepo: [],
      stopReason: null,
      budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
    };
  }

  // Start signal — without it dev-sync goes quiet for tens of seconds
  // (50 commits × 400ms pacing floor) while /diffstat fetches stream through.
  deps.logger?.info?.(
    { queueSize: queue.length, budgetRemaining: deps.client.getBudgetRemaining() },
    'diff-stats backfill: starting',
  );

  // Per-repo rollup accumulators, keyed by repositoryId so a later commit
  // for an earlier-seen repo extends the existing day range.
  const perRepo = new Map<number, PerRepoDiffStatsResult & { workspace: string; slug: string }>();
  let totalUpdated = 0;
  let totalFailed = 0;
  let stopReason: 'budget' | 'rate-limited' | null = null;

  for (const commit of queue) {
    if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
      stopReason = 'budget';
      deps.logger?.warn?.(
        {
          remaining: deps.client.getBudgetRemaining(),
          threshold: opts.budgetThreshold,
          processed: totalUpdated + totalFailed,
          remainingInQueue: queue.length - (totalUpdated + totalFailed),
        },
        'diff-stats backfill: budget gate — deferring remaining commits to next tick',
      );
      break;
    }
    if (deps.client.isPacingSaturated()) {
      stopReason = 'rate-limited';
      deps.logger?.warn?.(
        {
          pacingMs: deps.client.getCurrentPacingMs(),
          processed: totalUpdated + totalFailed,
          remainingInQueue: queue.length - (totalUpdated + totalFailed),
        },
        'diff-stats backfill: pacer saturated — yielding tick to next cron',
      );
      break;
    }

    const bucket = perRepo.get(commit.repositoryId) ?? {
      repositoryId: commit.repositoryId,
      fullName: commit.fullName,
      workspace: commit.workspace,
      slug: commit.slug,
      updated: 0,
      failed: 0,
      range: null,
    };
    try {
      const stat = await getCommitDiffStat(
        deps.client,
        commit.workspace,
        commit.slug,
        commit.sha,
        commit.excludePatterns,
      );
      await deps.store.updateCommitDiffStats(commit.id, stat);
      bucket.updated++;
      totalUpdated++;
      const day = commit.authoredAt.toISOString().slice(0, 10);
      if (bucket.range === null) {
        bucket.range = { sinceDay: day, untilDay: day };
      } else {
        if (day < bucket.range.sinceDay) bucket.range.sinceDay = day;
        if (day > bucket.range.untilDay) bucket.range.untilDay = day;
      }
    } catch (err) {
      if (err instanceof BitbucketRateLimitError) {
        // Retry budget exhausted — yield the tick (same path as pacer-saturated).
        stopReason = 'rate-limited';
        deps.logger?.warn?.(
          {
            fullName: commit.fullName,
            sha: commit.sha,
            processed: totalUpdated + totalFailed,
            remainingInQueue: queue.length - (totalUpdated + totalFailed),
          },
          'diff-stats backfill: BB rate-limited after retry — yielding tick',
        );
        // Save bucket state for the rollup step before bailing.
        perRepo.set(commit.repositoryId, bucket);
        break;
      }
      bucket.failed++;
      totalFailed++;
      // HTTP 555 (BB compute timeout) is permanent for the commit shape —
      // weight 3 crosses the threshold on a single strike. Everything else
      // gets weight 1 (3 cross-tick failures before giving up).
      const is555 = err instanceof BitbucketApiError && err.status === 555;
      const weight = is555 ? DIFF_STATS_FAILURE_THRESHOLD : 1;
      const newCount = await deps.store.incrementDiffStatsFailure(commit.id, weight);
      if (newCount >= DIFF_STATS_FAILURE_THRESHOLD) {
        // Stamp with zeros so it drops out of the pickup — same shape as a
        // genuinely-zero-diff commit, but the surviving failure_count lets
        // readers tell them apart (activity feed shows an exclamation icon
        // when count >= threshold).
        await deps.store.updateCommitDiffStats(commit.id, { additions: 0, deletions: 0, filesChanged: 0 });
        deps.logger?.warn?.(
          {
            repositoryId: commit.repositoryId,
            fullName: commit.fullName,
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
            repositoryId: commit.repositoryId,
            fullName: commit.fullName,
            sha: commit.sha,
            failureCount: newCount,
            threshold: DIFF_STATS_FAILURE_THRESHOLD,
            err: err instanceof Error ? err.message : String(err),
          },
          'diff-stats fetch failed — leaving commit pending for next tick',
        );
      }
    }
    perRepo.set(commit.repositoryId, bucket);
  }

  // Rollup recompute per affected repo, then invalidate affected
  // user-summary cache entries. Failures here are freshness blips, not
  // data-integrity issues — log and continue.
  if (deps.rollupStore !== undefined) {
    for (const bucket of perRepo.values()) {
      if (bucket.range === null) continue;
      try {
        const { rowsAffected } = await deps.rollupStore.recomputeCommitDailyForRepo(bucket.repositoryId, bucket.range);
        deps.logger?.info?.(
          { repositoryId: bucket.repositoryId, fullName: bucket.fullName, range: bucket.range, rowsAffected },
          'diff-stats backfill: rollup recompute complete',
        );
      } catch (err) {
        deps.logger?.warn?.(
          {
            repositoryId: bucket.repositoryId,
            fullName: bucket.fullName,
            range: bucket.range,
            err: err instanceof Error ? err.message : String(err),
          },
          'diff-stats backfill: rollup recompute failed — will recover on next sync',
        );
        continue;
      }
      if (deps.userSummaryCache !== undefined) {
        try {
          const userIds = await deps.rollupStore.listAffectedUserIdsForRepo(bucket.repositoryId, bucket.range);
          await Promise.all(userIds.map((id) => deps.userSummaryCache!.invalidate(id)));
        } catch (err) {
          deps.logger?.warn?.(
            {
              repositoryId: bucket.repositoryId,
              fullName: bucket.fullName,
              err: err instanceof Error ? err.message : String(err),
            },
            'diff-stats backfill: user-summary cache invalidation failed — TTL backstop will catch up',
          );
        }
      }
    }
  }

  // Strip the internal workspace/slug fields before returning.
  const perRepoResult: PerRepoDiffStatsResult[] = [];
  for (const bucket of perRepo.values()) {
    perRepoResult.push({
      repositoryId: bucket.repositoryId,
      fullName: bucket.fullName,
      updated: bucket.updated,
      failed: bucket.failed,
      range: bucket.range,
    });
  }

  deps.logger?.info?.(
    {
      totalUpdated,
      totalFailed,
      repos: perRepoResult.length,
      stopReason,
      budgetRemaining: deps.client.getBudgetRemaining(),
    },
    'diff-stats backfill tick complete',
  );

  return {
    totalUpdated,
    totalFailed,
    perRepo: perRepoResult,
    stopReason,
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
  };
}
