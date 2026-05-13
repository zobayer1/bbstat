// Bounded-concurrency, budget-aware orchestrator over a list of tracked
// repositories' PR ingest. Same shape as commits-tick.ts — workers pull
// from a shared queue; before claiming the next repo each worker checks
// the client's outbound-call budget. If remaining headroom is below the
// safety threshold the worker stops scheduling and unclaimed repos are
// returned as `deferred` for the next tick.
//
// Errors in a single repo never abort the tick; they're collected
// per-repo so a transient 500 on one repo can't starve the others.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import type { RepositoryHandle } from './commits.js';
import type { PrStore } from './pr-store.js';
import {
  syncRepositoryPullRequests,
  type PrSyncDeps,
  type PrSyncOptions,
  type RepoPrSyncResult,
} from './pull-requests.js';

export interface PrTickDeps {
  client: BitbucketClient;
  store: PrStore;
  logger?: BitbucketLogger;
  // Per-repo sync function. Defaults to syncRepositoryPullRequests;
  // injectable so the orchestrator can be tested without standing up the
  // full BB client + store + fetch fixture stack.
  syncOne?: (deps: PrSyncDeps, repo: RepositoryHandle, opts: PrSyncOptions) => Promise<RepoPrSyncResult>;
}

export interface PrTickOptions extends PrSyncOptions {
  // Max repos in flight at once. PR ingest is slower-cadence than commits
  // (30-min cron default), so a modest concurrency keeps BB happy.
  concurrency?: number;
  // Safety margin under hourlyCallBudget. When getBudgetRemaining() falls
  // below this, no new repos are scheduled.
  budgetLowThreshold?: number;
}

export interface PrTickResult {
  attempted: RepoPrSyncResult[];
  deferred: RepositoryHandle[];
  errors: Array<{ repository: RepositoryHandle; error: string }>;
  stoppedEarly: boolean;
  budgetRemainingAtEnd: number;
}

const DEFAULTS = {
  concurrency: 3,
  budgetLowThreshold: 20,
} as const;

export async function runPullRequestsTick(
  deps: PrTickDeps,
  repos: RepositoryHandle[],
  opts: PrTickOptions = {},
): Promise<PrTickResult> {
  const concurrency = opts.concurrency ?? DEFAULTS.concurrency;
  const threshold = opts.budgetLowThreshold ?? DEFAULTS.budgetLowThreshold;
  const syncOne = deps.syncOne ?? syncRepositoryPullRequests;

  const queue: RepositoryHandle[] = [...repos];
  const attempted: RepoPrSyncResult[] = [];
  const errors: PrTickResult['errors'] = [];
  let stoppedEarly = false;

  const perRepoDeps: PrSyncDeps = {
    client: deps.client,
    store: deps.store,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  const perRepoOpts: PrSyncOptions = {
    ...(opts.firstRunMaxPages !== undefined ? { firstRunMaxPages: opts.firstRunMaxPages } : {}),
  };

  const work = async (): Promise<void> => {
    while (queue.length > 0) {
      if (deps.client.getBudgetRemaining() < threshold) {
        stoppedEarly = true;
        deps.logger?.warn?.(
          { remaining: deps.client.getBudgetRemaining(), threshold, deferred: queue.length },
          'PR tick: budget gate — deferring remaining repos',
        );
        return;
      }
      const repo = queue.shift();
      if (repo === undefined) return;
      try {
        const result = await syncOne(perRepoDeps, repo, perRepoOpts);
        attempted.push(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ repository: repo, error: message });
        deps.logger?.error?.(err, `PR tick: ${repo.fullName} failed`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => work()));

  return {
    attempted,
    deferred: queue,
    errors,
    stoppedEarly,
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
  };
}
