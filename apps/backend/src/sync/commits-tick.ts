// Bounded-concurrency, budget-aware orchestrator over a list of tracked
// repositories. One "tick" = one cron firing (or one manual run). Workers
// pull from a shared queue; before claiming the next repo each worker checks
// the client's outbound-call budget — if remaining headroom is below the
// safety threshold, the worker stops and any unclaimed repos are returned
// as `deferred` for the next tick.
//
// Errors in a single repo never abort the tick; they're collected per-repo
// so a transient 500 on one repo can't starve the others. Hard failures
// (caller wants to stop everything) should throw outside the worker by
// short-circuiting before runCommitsTick is even invoked.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { BitbucketRateLimitError } from '../bitbucket/errors.js';
import { syncRepositoryCommits } from './commits.js';
import type { CommitSyncDeps, CommitSyncOptions, RepoCommitSyncResult, RepositoryHandle } from './commits.js';
import type { CommitStore } from './commit-store.js';

export interface CommitsTickDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  // Per-repo sync function. Defaults to syncRepositoryCommits; injectable
  // so the orchestrator can be tested without standing up the full BB
  // client + store + fetch fixture stack.
  syncOne?: (deps: CommitSyncDeps, repo: RepositoryHandle, opts: CommitSyncOptions) => Promise<RepoCommitSyncResult>;
}

export interface CommitsTickOptions extends CommitSyncOptions {
  // Max repos in flight at once. BB Cloud is comfortable with a handful;
  // bumping past 5 risks bursting the per-second limit even when the
  // hourly budget has headroom.
  concurrency?: number;
  // Safety margin under hourlyCallBudget. When getBudgetRemaining() falls
  // below this, no new repos are scheduled. Should be >= the worst-case
  // per-repo cost (firstRunMaxPages × concurrency).
  budgetLowThreshold?: number;
}

export interface CommitsTickResult {
  attempted: RepoCommitSyncResult[];
  deferred: RepositoryHandle[];
  errors: Array<{ repository: RepositoryHandle; error: string }>;
  // True iff something stopped the tick before draining `repos` — see
  // `stopReason` for the cause. Pure "ran out of repos" finishes are
  // stoppedEarly=false even if `deferred` is empty.
  stoppedEarly: boolean;
  // Why the tick stopped. `null` = drained the queue cleanly. `'budget'` =
  // the BB-call budget gate fired. `'rate-limited'` = the adaptive pacer
  // hit its ceiling and a BB call still 429'd, exhausting the client
  // retry budget; remaining repos roll over to the next cron tick. Their
  // `last_synced_at` stays put (we never reached `markSyncSuccess`), so
  // the next tick's `ORDER BY last_synced_at ASC NULLS FIRST` puts them
  // at the head of the queue.
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

  // Per-repo deps strip out the tick-only `syncOne` injection.
  const perRepoDeps: CommitSyncDeps = {
    client: deps.client,
    store: deps.store,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  // syncOne sees the same options as the per-repo function — it ignores the
  // tick-specific knobs (concurrency, budgetLowThreshold) since they have
  // no meaning at that layer.
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
          // Adaptive pacing exhausted — BB still 429s at the cap. Put this
          // repo back at the head of the queue (it didn't get processed),
          // flag the tick-wide stop. Other workers will see it on their
          // next iteration. Logged at warn, not error: this is expected
          // backpressure that resolves on the next cron tick.
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
