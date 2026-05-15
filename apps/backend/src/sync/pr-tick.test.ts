// Bounded-concurrency / budget-gate tests for runPullRequestsTick. Mirrors
// commits-tick.test.ts — the orchestrator logic is identical; we test the
// PR-shaped result type, the deferred handoff, and per-repo error isolation.

import { describe, it, expect, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { RepositoryHandle } from './commits.js';
import type { PrStore } from './pr-store.js';
import { runPullRequestsTick } from './pr-tick.js';
import type { PrSyncDeps, PrSyncOptions, RepoPrSyncResult } from './pull-requests.js';

function makeRepo(id: number): RepositoryHandle {
  return {
    repositoryId: id,
    workspace: 'tigerit',
    slug: `repo-${id}`,
    fullName: `tigerit/repo-${id}`,
    diffStatsExcludePatterns: [],
  };
}

function fakeStore(): PrStore {
  const fail = (): never => {
    throw new Error('PrStore method called from tick test — should be unreachable');
  };
  return {
    resolveUserIdsByUuid: fail,
    upsertPullRequests: fail,
    getPrSyncState: fail,
    markPrSyncSuccess: fail,
  };
}

function makeClientWithBudget(opts: { budget: number; calls?: number; now?: () => number }): BitbucketClient {
  const noFetch = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 }));
  const client = new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@b.c',
    token: 't',
    fetch: noFetch as unknown as typeof globalThis.fetch,
    hourlyCallBudget: opts.budget,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const seedCalls = opts.calls ?? 0;
  const t = (opts.now ?? Date.now)();
  for (let i = 0; i < seedCalls; i++) {
    // @ts-expect-error — exercising the private ledger for test seeding.
    client.callTimestamps.push(t);
  }
  return client;
}

function makeOkResult(repo: RepositoryHandle): RepoPrSyncResult {
  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    mode: 'delta',
    fetched: 0,
    inserted: 0,
    updated: 0,
    newCursor: null,
    hitKnownCursor: false,
    hitPageCap: false,
  };
}

describe('runPullRequestsTick', () => {
  it('runs every repo when budget is plentiful', async () => {
    const repos = [makeRepo(1), makeRepo(2), makeRepo(3)];
    const syncOne = vi.fn(async (_d: PrSyncDeps, r: RepositoryHandle): Promise<RepoPrSyncResult> => makeOkResult(r));

    const result = await runPullRequestsTick(
      { client: makeClientWithBudget({ budget: 1000 }), store: fakeStore(), syncOne },
      repos,
      { concurrency: 3, budgetLowThreshold: 20 },
    );

    expect(result.attempted).toHaveLength(3);
    expect(result.deferred).toEqual([]);
    expect(result.stoppedEarly).toBe(false);
  });

  it('defers repos when budget falls below threshold', async () => {
    const repos = Array.from({ length: 5 }, (_, i) => makeRepo(i + 1));
    // Each per-repo "sync" consumes one BB call from the ledger by hitting
    // a fake fetch via the BB client itself; instead, simulate consumption
    // by pre-seeding the ledger close to the budget cap and using a no-op
    // syncOne.
    const client = makeClientWithBudget({ budget: 30, calls: 0 });

    const syncOne = vi.fn(async (_d: PrSyncDeps, r: RepositoryHandle): Promise<RepoPrSyncResult> => {
      // Drain ~5 calls per repo to simulate paginatePullRequests + upsert
      // pressure. The orchestrator checks getBudgetRemaining BEFORE each
      // repo, so after a few repos we'll trip the threshold.
      for (let i = 0; i < 5; i++) {
        // @ts-expect-error — exercising the private ledger.
        client.callTimestamps.push(Date.now());
      }
      return makeOkResult(r);
    });

    const result = await runPullRequestsTick({ client, store: fakeStore(), syncOne }, repos, {
      concurrency: 1,
      budgetLowThreshold: 20,
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.attempted.length + result.deferred.length).toBe(5);
    expect(result.attempted.length).toBeLessThan(5);
  });

  it('isolates per-repo errors instead of aborting the tick', async () => {
    const repos = [makeRepo(1), makeRepo(2), makeRepo(3)];
    const syncOne = vi.fn(async (_d: PrSyncDeps, r: RepositoryHandle): Promise<RepoPrSyncResult> => {
      if (r.repositoryId === 2) throw new Error('repo 2 boom');
      return makeOkResult(r);
    });

    const result = await runPullRequestsTick(
      { client: makeClientWithBudget({ budget: 1000 }), store: fakeStore(), syncOne },
      repos,
      { concurrency: 1, budgetLowThreshold: 20 },
    );

    expect(result.attempted).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.repository.repositoryId).toBe(2);
    expect(result.errors[0]?.error).toContain('repo 2 boom');
  });

  it('forwards firstRunMaxPages to the per-repo function as PrSyncOptions', async () => {
    const repos = [makeRepo(1)];
    const received: PrSyncOptions[] = [];
    const syncOne = vi.fn(async (_d: PrSyncDeps, r: RepositoryHandle, o: PrSyncOptions): Promise<RepoPrSyncResult> => {
      received.push(o);
      return makeOkResult(r);
    });

    await runPullRequestsTick({ client: makeClientWithBudget({ budget: 1000 }), store: fakeStore(), syncOne }, repos, {
      firstRunMaxPages: 3,
    });

    expect(received).toEqual([{ firstRunMaxPages: 3 }]);
  });
});
