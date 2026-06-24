// Bounded-concurrency, budget-aware orchestrator over PR ingest. Same shape
// as commits-tick.ts — workers pull from a shared queue, stop below the
// budget threshold and return unclaimed repos as `deferred`, and collect
// per-repo errors so one repo's failure can't starve the others.

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
  // Defaults to syncRepositoryPullRequests; injectable for tests.
  syncOne?: (deps: PrSyncDeps, repo: RepositoryHandle, opts: PrSyncOptions) => Promise<RepoPrSyncResult>;
}

export interface PrTickOptions extends PrSyncOptions {
  // Max repos in flight.
  concurrency?: number;
  // Safety margin under hourlyCallBudget; below it, no new repos scheduled.
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
