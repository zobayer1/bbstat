// Diff-stats backfill tick — global newest-first pickup.
//
// Drains pending diff-stat work (`commits.diff_stats_synced_at IS NULL`)
// across every non-archived non-excluded repo as a single ordered queue.
// Replaces the previous per-repo iteration: a repo with 5000 pending
// commits no longer monopolizes a tick by burning its 50-per-tick cap
// before any other repo gets attention. Recent commits everywhere
// land first.
//
// Priority placement in `runCommitsSync`:
//
//   commit tick → deepen tick → IS-MERGE BACKFILL → diff-stats backfill
//
// All four share the hourly BB-call budget. Running last, this step
// yields to commit-list ingest, history deepening, and merge-flag
// correction.
//
// Failure modes:
//   * BitbucketRateLimitError — tick-wide stop. The remaining pending
//     pool waits for the next cron firing (5 min) by which time BB's
//     rolling window has rotated and the pacer has decayed.
//   * BB 4xx / 5xx for a single commit — failed++, continue. The row
//     stays `diff_stats_synced_at IS NULL` and gets retried next tick.
//   * Adaptive pacer saturated — pre-emptive yield via RateLimitError,
//     same recovery path as above.
//
// Rollups: as commits land their diff stats, we accumulate a
// per-repo day-range map; at end of tick we fire one
// `commit_daily` recompute per affected repo. Same pattern as the
// commit-sync rollup hook.

import { getCommitDiffStat } from '../bitbucket/diff-stats.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore } from './commit-store.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';

export interface DiffStatsBackfillTickOptions {
  // Maximum commits processed per tick — total across all repos, not
  // per-repo. Caps burst size and per-tick wall-clock (~maxCommits ×
  // pacing). Default 100 in `config.ts`. Long-term throughput is
  // budget-limited (DIFF_STATS_BACKFILL_BUDGET_THRESHOLD yields the
  // tick when the rolling 1000/hr cap is approached), so the cap
  // mostly controls burst size, not steady-state drain rate.
  maxCommitsPerTick: number;
  // Headroom required under BITBUCKET_HOURLY_CALL_BUDGET. When
  // `getBudgetRemaining()` falls below this the loop bails and the
  // remaining pool waits for the next tick.
  budgetThreshold: number;
}

export interface DiffStatsBackfillTickDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  rollupStore?: RollupStore;
  userSummaryCache?: UserSummaryCache;
}

// Per-repo summary of work done this tick. Only repos that had at
// least one commit processed appear — drained-clean repos are
// silently absent. Surfaced for log line clarity and for the rollup
// recompute step which fires once per non-empty entry.
export interface PerRepoDiffStatsResult {
  repositoryId: number;
  fullName: string;
  updated: number;
  failed: number;
  range: { sinceDay: string; untilDay: string } | null;
}

export interface DiffStatsBackfillTickResult {
  // Total commits whose diff stats landed this tick.
  totalUpdated: number;
  // Per-commit failures that did NOT abort the tick (transient
  // 4xx/5xx, malformed responses). Per-row remains pending.
  totalFailed: number;
  // Per-repo breakdown of work done. Empty when the tick had nothing
  // to do (queue drained) — also empty when the very first call
  // saturated the pacer.
  perRepo: PerRepoDiffStatsResult[];
  // null = drained cleanly. 'budget' = BB-call budget gate fired.
  // 'rate-limited' = BB pushed back hard (retry budget exhausted OR
  // adaptive pacer saturated).
  stopReason: 'budget' | 'rate-limited' | null;
  budgetRemainingAtEnd: number;
}

export async function runDiffStatsBackfillTick(
  deps: DiffStatsBackfillTickDeps,
  opts: DiffStatsBackfillTickOptions,
): Promise<DiffStatsBackfillTickResult> {
  // Single round-trip global pickup. Returns up to `maxCommitsPerTick`
  // newest-authored pending commits with their repo identity attached.
  const queue = await deps.store.listPendingDiffStatCommitsGlobal(opts.maxCommitsPerTick);
  if (queue.length === 0) {
    // Matches the deepen / is-merge ticks' "queue drained" log so an
    // operator scanning dev-sync output can confirm the step ran.
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

  // One-line start signal so the operator knows the tick is running
  // and has a rough ETA — without it, dev-sync goes quiet for tens of
  // seconds (50 commits × 400ms pacing floor) while /diffstat
  // fetches stream through.
  deps.logger?.info?.(
    { queueSize: queue.length, budgetRemaining: deps.client.getBudgetRemaining() },
    'diff-stats backfill: starting',
  );

  // Per-repo accumulators for the rollup step. Keyed by repositoryId
  // so a commit that arrives later in the queue for an earlier-seen
  // repo extends the existing day range correctly.
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
        // In-request retry budget exhausted. Yield the tick — same
        // recovery path as the pacer-saturated case.
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
      deps.logger?.warn?.(
        {
          repositoryId: commit.repositoryId,
          fullName: commit.fullName,
          sha: commit.sha,
          err: err instanceof Error ? err.message : String(err),
        },
        'diff-stats fetch failed — leaving commit pending for next tick',
      );
    }
    perRepo.set(commit.repositoryId, bucket);
  }

  // Rollup recompute per affected repo. Each non-null range scopes the
  // commit_daily refresh; user-summary cache entries for affected
  // users are DEL'd so the next read repopulates from fresh data.
  // Failures here are dashboard-freshness blips, not data-integrity
  // issues — log and continue.
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
