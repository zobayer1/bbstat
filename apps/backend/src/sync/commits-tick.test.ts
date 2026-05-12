import { describe, it, expect } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { CommitSyncDeps, CommitSyncOptions, RepoCommitSyncResult, RepositoryHandle } from './commits.js';
import type { CommitStore } from './commit-store.js';
import { runCommitsTick } from './commits-tick.js';

// Tick-level tests inject a stub `syncOne` so they exercise concurrency, the
// budget gate, and error tolerance without standing up the full per-repo
// stack (that lives in commits.test.ts).

function makeRepo(id: number): RepositoryHandle {
  return { repositoryId: id, workspace: 'tigerit', slug: `repo-${id}`, fullName: `tigerit/repo-${id}` };
}

function fakeStore(): CommitStore {
  // Tick should never reach the store directly when syncOne is stubbed.
  const fail = (): never => {
    throw new Error('CommitStore method called from tick test — should be unreachable');
  };
  return {
    resolveUserIdsByUuid: fail,
    insertCommits: fail,
    getSyncState: fail,
    markSyncRunning: fail,
    markSyncSuccess: fail,
    markSyncFailed: fail,
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
  // Pre-load fake call timestamps to set the starting "calls used" state.
  const seedCalls = opts.calls ?? 0;
  const t = (opts.now ?? Date.now)();
  for (let i = 0; i < seedCalls; i++) {
    // @ts-expect-error — exercising the private ledger for test seeding.
    client.callTimestamps.push(t);
  }
  return client;
}

function makeOkResult(repo: RepositoryHandle): RepoCommitSyncResult {
  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    mode: 'delta',
    fetched: 0,
    inserted: 0,
    newCursor: null,
    hitKnownSha: false,
    hitPageCap: false,
    hitDateCap: false,
    insertedRange: null,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------

describe('runCommitsTick', () => {
  it('processes every repo when budget is unconstrained', async () => {
    const repos = [makeRepo(1), makeRepo(2), makeRepo(3)];
    const seen: number[] = [];
    const syncOne = async (
      _d: CommitSyncDeps,
      r: RepositoryHandle,
      _o: CommitSyncOptions,
    ): Promise<RepoCommitSyncResult> => {
      seen.push(r.repositoryId);
      return makeOkResult(r);
    };

    const result = await runCommitsTick(
      { client: makeClientWithBudget({ budget: 1000 }), store: fakeStore(), syncOne },
      repos,
    );

    expect(result.attempted).toHaveLength(3);
    expect(result.deferred).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.stoppedEarly).toBe(false);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('respects concurrency: at most N repos in flight at once', async () => {
    const repos = Array.from({ length: 8 }, (_, i) => makeRepo(i + 1));
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = repos.map(() => deferred<void>());

    const syncOne = async (_d: CommitSyncDeps, r: RepositoryHandle): Promise<RepoCommitSyncResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[r.repositoryId - 1]!.promise;
      inFlight--;
      return makeOkResult(r);
    };

    const tickPromise = runCommitsTick(
      { client: makeClientWithBudget({ budget: 1000 }), store: fakeStore(), syncOne },
      repos,
      { concurrency: 3 },
    );

    // Let the workers spin up + claim their first 3 repos.
    await new Promise((r) => setTimeout(r, 0));
    expect(maxInFlight).toBeLessThanOrEqual(3);

    // Resolve gates in order; each release should let exactly one new repo start.
    for (const g of gates) g.resolve();

    const result = await tickPromise;
    expect(result.attempted).toHaveLength(8);
    expect(maxInFlight).toBe(3);
  });

  it('stops scheduling new repos when budget falls below threshold', async () => {
    const repos = Array.from({ length: 5 }, (_, i) => makeRepo(i + 1));
    // Budget=100, threshold=30. Already 80 used → 20 remaining → below 30 → gate fires immediately.
    const client = makeClientWithBudget({ budget: 100, calls: 80 });
    let calls = 0;

    const result = await runCommitsTick(
      {
        client,
        store: fakeStore(),
        syncOne: async (_d, r) => {
          calls++;
          return makeOkResult(r);
        },
      },
      repos,
      { concurrency: 1, budgetLowThreshold: 30 },
    );

    expect(calls).toBe(0);
    expect(result.attempted).toEqual([]);
    expect(result.deferred).toHaveLength(5);
    expect(result.stoppedEarly).toBe(true);
  });

  it('processes some, defers the rest when budget runs out mid-tick', async () => {
    const repos = Array.from({ length: 6 }, (_, i) => makeRepo(i + 1));
    // Each syncOne adds 50 fake calls to the client's ledger (via internal cast)
    // simulating per-repo API spend. Budget=200, threshold=10.
    const client = makeClientWithBudget({ budget: 200 });

    const result = await runCommitsTick(
      {
        client,
        store: fakeStore(),
        syncOne: async (_d, r) => {
          // @ts-expect-error — seeding ledger to model per-repo cost
          client.callTimestamps.push(...Array(50).fill(Date.now()));
          return makeOkResult(r);
        },
      },
      repos,
      { concurrency: 1, budgetLowThreshold: 10 },
    );

    // After repo 1 → 50 used, 150 left ≥ 10 → continue.
    // After repo 2 → 100 used, 100 left ≥ 10 → continue.
    // After repo 3 → 150 used, 50 left ≥ 10 → continue.
    // After repo 4 → 200 used, 0 left < 10 → stop.
    expect(result.attempted).toHaveLength(4);
    expect(result.deferred).toHaveLength(2);
    expect(result.stoppedEarly).toBe(true);
    expect(result.deferred.map((r) => r.repositoryId)).toEqual([5, 6]);
  });

  it('errors in one repo do not abort siblings — each error is recorded per-repo', async () => {
    const repos = [makeRepo(1), makeRepo(2), makeRepo(3)];

    const result = await runCommitsTick(
      {
        client: makeClientWithBudget({ budget: 1000 }),
        store: fakeStore(),
        syncOne: async (_d, r) => {
          if (r.repositoryId === 2) throw new Error('upstream 500');
          return makeOkResult(r);
        },
      },
      repos,
      { concurrency: 1 },
    );

    expect(result.attempted.map((a) => a.repositoryId).sort()).toEqual([1, 3]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.repository.repositoryId).toBe(2);
    expect(result.errors[0]!.error).toBe('upstream 500');
    expect(result.stoppedEarly).toBe(false);
  });

  it('forwards firstRunMaxPages / firstRunSince / include to per-repo sync', async () => {
    const seen: CommitSyncOptions[] = [];
    const since = new Date('2026-01-01T00:00:00Z');

    await runCommitsTick(
      {
        client: makeClientWithBudget({ budget: 1000 }),
        store: fakeStore(),
        syncOne: async (_d, r, o) => {
          seen.push(o);
          return makeOkResult(r);
        },
      },
      [makeRepo(1)],
      { firstRunMaxPages: 7, firstRunSince: since, include: 'main', concurrency: 1 },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ firstRunMaxPages: 7, firstRunSince: since, include: 'main' });
  });

  it('empty repos list returns an empty result without firing any worker', async () => {
    let called = false;
    const result = await runCommitsTick(
      {
        client: makeClientWithBudget({ budget: 1000 }),
        store: fakeStore(),
        syncOne: async () => {
          called = true;
          return makeOkResult(makeRepo(0));
        },
      },
      [],
    );

    expect(called).toBe(false);
    expect(result).toEqual({
      attempted: [],
      deferred: [],
      errors: [],
      stoppedEarly: false,
      budgetRemainingAtEnd: 1000,
    });
  });
});
