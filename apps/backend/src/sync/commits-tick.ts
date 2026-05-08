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
  // True iff the budget gate fired and we left repos in `deferred` rather
  // than running through the whole list. Pure "ran out of repos" finishes
  // are stoppedEarly=false even if `deferred` is empty.
  stoppedEarly: boolean;
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
  };

  const work = async (): Promise<void> => {
    while (queue.length > 0) {
      if (deps.client.getBudgetRemaining() < threshold) {
        stoppedEarly = true;
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
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
  };
}
