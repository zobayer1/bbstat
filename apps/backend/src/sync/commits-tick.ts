// Bounded-concurrency, budget-aware orchestrator over a list of tracked
// repositories. One "tick" = one cron firing (or one manual run). Workers
// pull from a shared queue; before claiming the next repo each worker checks
// the client's outbound-call budget — below the safety threshold it stops
// and any unclaimed repos are returned as `deferred` for the next tick.
//
// A single repo's error never aborts the tick; errors are collected per-repo
// so a transient 500 can't starve the others.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketRateLimitError } from '../bitbucket/errors.js';
import { syncRepositoryCommits } from './commits.js';
import type { CommitSyncDeps, CommitSyncOptions, RepoCommitSyncResult, RepositoryHandle } from './commits.js';
import type { CommitStore } from './commit-store.js';
import type { DiscoveryStore } from './discovery-store.js';
import type { EventBus } from '../events/bus.js';

export interface CommitsTickDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  // Lets per-repo syncs auto-trip `sync_excluded` on 404 / history-rewrite.
  discoveryStore?: DiscoveryStore;
  // Lets the auto-trip publish `repository.sync-excluded` SSE events.
  bus?: EventBus;
  // Defaults to syncRepositoryCommits; injectable for tests.
  syncOne?: (deps: CommitSyncDeps, repo: RepositoryHandle, opts: CommitSyncOptions) => Promise<RepoCommitSyncResult>;
}

export interface CommitsTickOptions extends CommitSyncOptions {
  // Max repos in flight. Past ~5 risks bursting the per-second limit even
  // when the hourly budget has headroom.
  concurrency?: number;
  // Safety margin under hourlyCallBudget. Should be >= the worst-case
  // per-repo cost (firstRunMaxPages × concurrency).
  budgetLowThreshold?: number;
}

export interface CommitsTickResult {
  attempted: RepoCommitSyncResult[];
  deferred: RepositoryHandle[];
  errors: Array<{ repository: RepositoryHandle; error: string }>;
  // True iff something stopped the tick before draining `repos`. Pure
  // "ran out of repos" finishes are false even if `deferred` is empty.
  stoppedEarly: boolean;
  // `null` = drained cleanly. `'budget'` = budget gate fired.
  // `'rate-limited'` = pacer hit its ceiling and a BB call still 429'd;
  // remaining repos roll to the next tick. Their `last_synced_at` stays
  // put (never reached `markSyncSuccess`), so `ORDER BY last_synced_at
  // ASC NULLS FIRST` puts them at the head of the next queue.
  stopReason: 'budget' | 'rate-limited' | null;
  budgetRemainingAtEnd: number;
}

const DEFAULTS = {
  concurrency: 3,
  budgetLowThreshold: 20,
} as const;

export async function runCommitsTick(
  deps: CommitsTickDeps,
  repos: RepositoryHandle[],
  opts: CommitsTickOptions = {},
): Promise<CommitsTickResult> {
  const concurrency = opts.concurrency ?? DEFAULTS.concurrency;
  const threshold = opts.budgetLowThreshold ?? DEFAULTS.budgetLowThreshold;
  const syncOne = deps.syncOne ?? syncRepositoryCommits;

  const queue: RepositoryHandle[] = [...repos];
  const attempted: RepoCommitSyncResult[] = [];
  const errors: CommitsTickResult['errors'] = [];
  let stoppedEarly = false;
  let stopReason: 'budget' | 'rate-limited' | null = null;

  // Per-repo deps strip the tick-only `syncOne` injection.
  const perRepoDeps: CommitSyncDeps = {
    client: deps.client,
    store: deps.store,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.discoveryStore ? { discoveryStore: deps.discoveryStore } : {}),
    ...(deps.bus ? { bus: deps.bus } : {}),
  };
  // Drop the tick-specific knobs (concurrency, budgetLowThreshold) that
  // have no meaning at the per-repo layer.
  const perRepoOpts: CommitSyncOptions = {
    ...(opts.firstRunMaxPages !== undefined ? { firstRunMaxPages: opts.firstRunMaxPages } : {}),
    ...(opts.firstRunSince !== undefined ? { firstRunSince: opts.firstRunSince } : {}),
    ...(opts.include !== undefined ? { include: opts.include } : {}),
    ...(opts.diffStats !== undefined ? { diffStats: opts.diffStats } : {}),
  };

  const work = async (): Promise<void> => {
    while (queue.length > 0) {
      // Tick-wide abort signal — any worker that hit
      // BitbucketRateLimitError flipped stopReason; everyone else stops too.
      if (stopReason === 'rate-limited') return;
      if (deps.client.getBudgetRemaining() < threshold) {
        stoppedEarly = true;
        stopReason = 'budget';
        deps.logger?.warn?.(
          { remaining: deps.client.getBudgetRemaining(), threshold, deferred: queue.length },
          'commit tick: budget gate — deferring remaining repos',
        );
        return;
      }
      const repo = queue.shift();
      if (repo === undefined) return;
      try {
        const result = await syncOne(perRepoDeps, repo, perRepoOpts);
        attempted.push(result);
      } catch (err) {
        if (err instanceof BitbucketRateLimitError) {
          // BB still 429s at the pacing cap. Put this unprocessed repo back
          // at the head of the queue and flag the tick-wide stop. Warn, not
          // error: expected backpressure that resolves on the next tick.
          queue.unshift(repo);
          stoppedEarly = true;
          stopReason = 'rate-limited';
          deps.logger?.warn?.(
            {
              repository: repo.fullName,
              pacingMs: deps.client.getCurrentPacingMs(),
              deferred: queue.length,
            },
            'commit tick: BB rate-limited at max pacing — yielding remaining queue to next tick',
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ repository: repo, error: message });
        deps.logger?.error?.(err, `commit tick: ${repo.fullName} failed`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => work()));

  return {
    attempted,
    deferred: queue,
    errors,
    stoppedEarly,
    stopReason,
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
  };
}
