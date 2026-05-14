// Diff-stats backfill tick. Runs after the deepen-backfill tick and
// drains pending diff-stat work (commits with
// `diff_stats_synced_at IS NULL`) across all opted-in repos.
//
// Priority placement:
//   commit tick → deepen tick → diff-stats backfill tick
//
// All three share the same hourly BB-call budget. By running last, this
// tick yields to commit-list ingest and history deepening — fresh
// commits and history coverage take precedence over filling in adds /
// dels / files_changed on older commits. The inline-eager forward path
// inside `syncRepositoryCommits` already covers stats for commits that
// land in the current cron tick, so the backfill here is mostly:
//
//   - one-time historical catch-up after enabling `diffStatsEnabled` on
//     a repo that already has ingested history, and
//   - commits whose inline-eager fetch failed transiently and stayed
//     pending for the next tick.
//
// Errors in a single repo never abort the tick; they're collected per-
// repo so a transient 500 on one repo can't starve the others. Tick-wide
// abort is reserved for BitbucketRateLimitError (the adaptive pacer's
// hard ceiling — same pattern as commits-tick and deepen-backfill).

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';
import {
  syncRepositoryDiffStats,
  type DiffStatsSyncDeps,
  type DiffStatsSyncOptions,
  type DiffStatsSyncResult,
} from './diff-stats.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';

export interface DiffStatsBackfillTickOptions extends DiffStatsSyncOptions {
  // Max repos in flight at once. Defaults to 1 (serial). Lower than
  // commits-tick because the inner walker already paces BB calls, and
  // because this tick is the last consumer of the hourly budget.
  concurrency?: number;
}

export interface DiffStatsBackfillTickDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  // When present, after each repo's diff-stats walk yields a non-empty
  // range, recompute commit_daily for that range and invalidate user-
  // summary cache entries for affected users. Absent in unit tests that
  // don't care about rollups.
  rollupStore?: RollupStore;
  userSummaryCache?: UserSummaryCache;
  // Per-repo sync function. Defaults to syncRepositoryDiffStats;
  // injectable so the orchestrator can be tested without standing up
  // the full BB client + store + fetch fixture stack.
  syncOne?: (
    deps: DiffStatsSyncDeps,
    repo: RepositoryHandle,
    opts: DiffStatsSyncOptions,
  ) => Promise<DiffStatsSyncResult>;
}

export interface RepoDiffStatsBackfillResult extends DiffStatsSyncResult {
  repositoryId: number;
  fullName: string;
}

export interface DiffStatsBackfillTickResult {
  attempted: RepoDiffStatsBackfillResult[];
  deferred: RepositoryHandle[];
  errors: Array<{ repository: RepositoryHandle; error: string }>;
  // True iff something stopped the tick before draining `repos`. See
  // `stopReason` for the cause. Pure "ran out of repos" finishes are
  // stoppedEarly=false even if `deferred` is empty.
  stoppedEarly: boolean;
  // `null` = drained the queue cleanly. `'budget'` = the BB-call budget
  // gate fired. `'rate-limited'` = the adaptive pacer hit its ceiling
  // and a BB call still 429'd; remaining repos roll over to next tick.
  stopReason: 'budget' | 'rate-limited' | null;
  budgetRemainingAtEnd: number;
  // Totals across all attempted repos, for terse log lines.
  totalUpdated: number;
  totalFailed: number;
}

const DEFAULTS = {
  concurrency: 1,
} as const;

export async function runDiffStatsBackfillTick(
  deps: DiffStatsBackfillTickDeps,
  repos: RepositoryHandle[],
  opts: DiffStatsBackfillTickOptions,
): Promise<DiffStatsBackfillTickResult> {
  const concurrency = opts.concurrency ?? DEFAULTS.concurrency;
  const syncOne = deps.syncOne ?? syncRepositoryDiffStats;

  // Opt-out repos are filtered before workers see them so the deferred
  // list reflects "could have run but the tick stopped first" rather
  // than "never eligible." Cheaper than the per-repo short-circuit
  // inside `syncRepositoryDiffStats` once the queue is large.
  const queue: RepositoryHandle[] = repos.filter((r) => r.diffStatsEnabled);
  const attempted: RepoDiffStatsBackfillResult[] = [];
  const errors: DiffStatsBackfillTickResult['errors'] = [];
  let stoppedEarly = false;
  let stopReason: 'budget' | 'rate-limited' | null = null;

  const perRepoDeps = {
    client: deps.client,
    store: deps.store,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };

  const work = async (): Promise<void> => {
    while (queue.length > 0) {
      if (stopReason === 'rate-limited') return;
      if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
        stoppedEarly = true;
        stopReason = 'budget';
        deps.logger?.warn?.(
          { remaining: deps.client.getBudgetRemaining(), threshold: opts.budgetThreshold, deferred: queue.length },
          'diff-stats backfill tick: budget gate — deferring remaining repos',
        );
        return;
      }
      const repo = queue.shift();
      if (repo === undefined) return;
      try {
        const result = await syncOne(perRepoDeps, repo, opts);
        attempted.push({ ...result, repositoryId: repo.repositoryId, fullName: repo.fullName });

        // Rollup + cache invalidation when this repo's walk produced new
        // diff stats. Errors here are dashboard-freshness blips, not
        // data-integrity issues — log and move on.
        if (result.diffStatsRange !== null && deps.rollupStore !== undefined) {
          await applyRollup(deps, repo, result.diffStatsRange);
        }
      } catch (err) {
        if (err instanceof BitbucketRateLimitError) {
          queue.unshift(repo);
          stoppedEarly = true;
          stopReason = 'rate-limited';
          deps.logger?.warn?.(
            {
              repository: repo.fullName,
              pacingMs: deps.client.getCurrentPacingMs(),
              deferred: queue.length,
            },
            'diff-stats backfill tick: BB rate-limited at max pacing — yielding remaining queue to next tick',
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ repository: repo, error: message });
        deps.logger?.error?.(err, `diff-stats backfill tick: ${repo.fullName} failed`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => work()));

  const totalUpdated = attempted.reduce((acc, r) => acc + r.updated, 0);
  const totalFailed = attempted.reduce((acc, r) => acc + r.failed, 0);

  return {
    attempted,
    deferred: queue,
    errors,
    stoppedEarly,
    stopReason,
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
    totalUpdated,
    totalFailed,
  };
}

async function applyRollup(
  deps: DiffStatsBackfillTickDeps,
  repo: RepositoryHandle,
  range: { sinceDay: string; untilDay: string },
): Promise<void> {
  if (deps.rollupStore === undefined) return;
  try {
    const { rowsAffected } = await deps.rollupStore.recomputeCommitDailyForRepo(repo.repositoryId, range);
    deps.logger?.info?.(
      { repositoryId: repo.repositoryId, fullName: repo.fullName, range, rowsAffected },
      'diff-stats backfill: rollup recompute complete',
    );
  } catch (err) {
    deps.logger?.warn?.(
      {
        repositoryId: repo.repositoryId,
        fullName: repo.fullName,
        range,
        err: err instanceof Error ? err.message : String(err),
      },
      'diff-stats backfill: rollup recompute failed — will recover on next sync',
    );
    return;
  }
  if (deps.userSummaryCache !== undefined) {
    try {
      const userIds = await deps.rollupStore.listAffectedUserIdsForRepo(repo.repositoryId, range);
      await Promise.all(userIds.map((id) => deps.userSummaryCache!.invalidate(id)));
      deps.logger?.info?.(
        { repositoryId: repo.repositoryId, fullName: repo.fullName, invalidatedUserCount: userIds.length },
        'diff-stats backfill: user-summary cache invalidated',
      );
    } catch (err) {
      deps.logger?.warn?.(
        {
          repositoryId: repo.repositoryId,
          fullName: repo.fullName,
          range,
          err: err instanceof Error ? err.message : String(err),
        },
        'diff-stats backfill: user-summary cache invalidation failed — entries will fall out via TTL',
      );
    }
  }
}
