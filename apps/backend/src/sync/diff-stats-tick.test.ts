import { describe, expect, it } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import { BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';
import { runDiffStatsBackfillTick } from './diff-stats-tick.js';
import type { DiffStatsSyncOptions, DiffStatsSyncResult } from './diff-stats.js';
import type { RollupStore } from '../dashboard/rollup-store.js';

function makeRepo(id: number, slug: string, diffStatsEnabled = true): RepositoryHandle {
  return {
    repositoryId: id,
    workspace: 'tigerit',
    slug,
    fullName: `tigerit/${slug}`,
    diffStatsEnabled,
  };
}

// Fake CommitStore — the tick itself never calls these methods; the
// per-repo syncOne does. By injecting `syncOne` directly, the store can
// stay completely unreachable.
function unreachableStore(): CommitStore {
  const fail = (): never => {
    throw new Error('CommitStore method called from tick test — unexpected');
  };
  return {
    resolveUserIdsByUuid: fail,
    insertCommits: fail,
    getSyncState: fail,
    markSyncRunning: fail,
    markSyncSuccess: fail,
    markSyncFailed: fail,
    listPendingDiffStatCommits: fail,
    updateCommitDiffStats: fail,
    getOldestCommitSha: fail,
    pickRepoForDeepening: fail,
    markDeepenAttempt: fail,
    markDeepenComplete: fail,
    updateIsMergeBatch: fail,
    pickRepoForIsMergeBackfill: fail,
    markIsMergeBackfillAttempt: fail,
    advanceIsMergeBackfillCursor: fail,
    markIsMergeBackfillComplete: fail,
  };
}

// Real client only because the tick reads `getBudgetRemaining()` on it.
// Tests that inject `syncOne` never actually emit HTTP calls; the call
// ledger is seeded directly for budget-gate scenarios.
function makeClient(opts: { budget?: number; calls?: number } = {}): BitbucketClient {
  const noFetch = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 }));
  const client = new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@b.c',
    token: 't',
    fetch: noFetch as unknown as typeof globalThis.fetch,
    hourlyCallBudget: opts.budget ?? 1000,
    retryBaseDelayMs: 0,
  });
  burnCalls(client, opts.calls ?? 0);
  return client;
}

// Push fake timestamps into the client's private call ledger so
// `getBudgetRemaining()` reflects the desired state. Mirrors the pattern
// in commits-tick.test.ts.
function burnCalls(client: BitbucketClient, n: number): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    // @ts-expect-error — exercising the private ledger for test seeding.
    client.callTimestamps.push(now);
  }
}

// A `syncOne` stub that simulates fetching N commits per repo (each
// "fetch" burns one slot of the client budget so the budget gate can
// be exercised without a real fetch). Returns a synthetic result.
function makeOkSyncOne(
  client: BitbucketClient,
  perRepo: Record<number, { updated: number; range: { sinceDay: string; untilDay: string } | null }>,
) {
  return async (_deps: unknown, repo: RepositoryHandle, _opts: DiffStatsSyncOptions): Promise<DiffStatsSyncResult> => {
    const spec = perRepo[repo.repositoryId] ?? { updated: 0, range: null };
    burnCalls(client, spec.updated);
    return {
      updated: spec.updated,
      failed: 0,
      deferred: 0,
      hitBudgetGate: false,
      diffStatsRange: spec.range,
    };
  };
}

describe('runDiffStatsBackfillTick', () => {
  it('walks every opted-in repo and aggregates totals', async () => {
    const client = makeClient();
    const syncOne = makeOkSyncOne(client, {
      1: { updated: 1, range: { sinceDay: '2026-05-04', untilDay: '2026-05-04' } },
      2: { updated: 2, range: { sinceDay: '2026-05-02', untilDay: '2026-05-03' } },
    });
    const repos = [makeRepo(1, 'r1'), makeRepo(2, 'r2')];

    const result = await runDiffStatsBackfillTick({ client, store: unreachableStore(), syncOne }, repos, {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.totalUpdated).toBe(3);
    expect(result.totalFailed).toBe(0);
    expect(result.stoppedEarly).toBe(false);
    expect(result.stopReason).toBeNull();
    expect(result.attempted.map((a) => a.repositoryId)).toEqual([1, 2]);
  });

  it('filters out diffStatsEnabled=false repos before scheduling', async () => {
    const client = makeClient();
    const seen: number[] = [];
    const syncOne = async (
      _deps: unknown,
      repo: RepositoryHandle,
      _opts: DiffStatsSyncOptions,
    ): Promise<DiffStatsSyncResult> => {
      seen.push(repo.repositoryId);
      return { updated: 0, failed: 0, deferred: 0, hitBudgetGate: false, diffStatsRange: null };
    };
    const repos = [makeRepo(1, 'r1', true), makeRepo(2, 'r2', false), makeRepo(3, 'r3', true)];

    const result = await runDiffStatsBackfillTick({ client, store: unreachableStore(), syncOne }, repos, {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(seen).toEqual([1, 3]);
    // Both opted-in repos were walked, but they returned all-zero
    // results (drained); the tick suppresses zero entries from
    // `attempted[]` so `attemptedCount` is the surviving signal.
    expect(result.attempted).toEqual([]);
    expect(result.attemptedCount).toBe(2);
  });

  it('stops scheduling when the budget gate fires; remaining repos roll over', async () => {
    // budget=20, pre-burn 5 → remaining=15. threshold=10. Repo 1 fits
    // (15 >= 10), syncOne burns 6 more → remaining=9. Next iteration:
    // 9 < 10 → gate trips before repo 2 is picked.
    const client = makeClient({ budget: 20, calls: 5 });
    const syncOne = makeOkSyncOne(client, {
      1: { updated: 6, range: { sinceDay: '2026-05-04', untilDay: '2026-05-04' } },
      2: { updated: 6, range: { sinceDay: '2026-05-03', untilDay: '2026-05-03' } },
    });
    const repos = [makeRepo(1, 'r1'), makeRepo(2, 'r2')];

    const result = await runDiffStatsBackfillTick({ client, store: unreachableStore(), syncOne }, repos, {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.totalUpdated).toBe(6);
    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toBe('budget');
    expect(result.deferred.map((r) => r.repositoryId)).toEqual([2]);
  });

  it('rate-limit error: yields entire queue, puts current repo back at head', async () => {
    const client = makeClient();
    const syncOne = async (
      _deps: unknown,
      repo: RepositoryHandle,
      _opts: DiffStatsSyncOptions,
    ): Promise<DiffStatsSyncResult> => {
      if (repo.repositoryId === 2) {
        throw new BitbucketRateLimitError('/diffstat/sha-repo-2', 1);
      }
      return { updated: 0, failed: 0, deferred: 0, hitBudgetGate: false, diffStatsRange: null };
    };
    const repos = [makeRepo(1, 'r1'), makeRepo(2, 'r2'), makeRepo(3, 'r3')];

    const result = await runDiffStatsBackfillTick(
      { client, store: unreachableStore(), syncOne },
      repos,
      // concurrency=1 so the test is deterministic — repo 2's throw stops
      // the worker before it can pick up 3.
      { maxPerRepoPerTick: 50, budgetThreshold: 10, concurrency: 1 },
    );

    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toBe('rate-limited');
    // Repo 1 was walked but returned zero work → suppressed from
    // `attempted[]`; only `attemptedCount` reflects it.
    expect(result.attempted).toEqual([]);
    expect(result.attemptedCount).toBe(1);
    // Repo 2 (the one that 429'd) goes back at the head of the deferred
    // queue so the next tick retries it before any later repos.
    expect(result.deferred.map((r) => r.repositoryId)).toEqual([2, 3]);
    expect(result.errors).toEqual([]);
  });

  it('per-repo errors are isolated, the tick continues', async () => {
    const client = makeClient();
    const syncOne = async (
      _deps: unknown,
      repo: RepositoryHandle,
      _opts: DiffStatsSyncOptions,
    ): Promise<DiffStatsSyncResult> => {
      if (repo.repositoryId === 1) throw new Error('first repo blew up');
      return {
        updated: 1,
        failed: 0,
        deferred: 0,
        hitBudgetGate: false,
        diffStatsRange: { sinceDay: '2026-05-03', untilDay: '2026-05-03' },
      };
    };
    const repos = [makeRepo(1, 'r1'), makeRepo(2, 'r2')];

    const result = await runDiffStatsBackfillTick({ client, store: unreachableStore(), syncOne }, repos, {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.errors.map((e) => e.repository.repositoryId)).toEqual([1]);
    expect(result.attempted.map((a) => a.repositoryId)).toEqual([2]);
    expect(result.totalUpdated).toBe(1);
    expect(result.stoppedEarly).toBe(false);
    expect(result.stopReason).toBeNull();
  });

  it('triggers rollup recompute + cache invalidation per repo when wired', async () => {
    const client = makeClient();
    const syncOne = makeOkSyncOne(client, {
      1: { updated: 1, range: { sinceDay: '2026-05-04', untilDay: '2026-05-04' } },
      2: { updated: 0, range: null }, // no range → no rollup
    });
    const recomputed: Array<{ repositoryId: number; range: unknown }> = [];
    const invalidated: number[] = [];
    const rollupStore: RollupStore = {
      async recomputeCommitDailyForRepo(repositoryId, range) {
        recomputed.push({ repositoryId, range });
        return { rowsAffected: 1 };
      },
      async listAffectedUserIdsForRepo() {
        return [101, 102];
      },
      async rebuildAll() {
        throw new Error('not used');
      },
    };
    const userSummaryCache = {
      async get() {
        return null;
      },
      async set() {},
      async invalidate(id: number) {
        invalidated.push(id);
      },
    };
    const repos = [makeRepo(1, 'r1'), makeRepo(2, 'r2')];

    await runDiffStatsBackfillTick(
      { client, store: unreachableStore(), syncOne, rollupStore, userSummaryCache },
      repos,
      { maxPerRepoPerTick: 50, budgetThreshold: 10 },
    );

    // Only repo 1 produced a range, so only it gets a recompute call.
    expect(recomputed).toEqual([{ repositoryId: 1, range: { sinceDay: '2026-05-04', untilDay: '2026-05-04' } }]);
    expect(invalidated.sort()).toEqual([101, 102]);
  });
});
