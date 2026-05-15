// Tests for `runDiffStatsBackfillTick` — global newest-first pickup
// orchestrator. The legacy per-repo iteration (`syncRepositoryDiffStats`
// driven from a `repos[]` list) was removed in 2026-05; the
// `diffStatsEnabled` opt-in column with it.
//
// Today the tick takes a single `(deps, opts)` call. The store's
// `listPendingDiffStatCommitsGlobal(limit)` returns the queue
// pre-joined with repo identity, ordered by `commits.authored_at DESC`.
// We mock the store so the queue is deterministic and inject a
// BitbucketClient with a stubbed fetch so /diffstat calls are
// observable (and we can drive `getBudgetRemaining()` / pacer
// saturation independently).

import { describe, expect, it, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { CommitStore, PendingDiffStatCommitWithRepo } from './commit-store.js';
import { runDiffStatsBackfillTick } from './diff-stats-tick.js';
import type { RollupStore } from '../dashboard/rollup-store.js';

// --- store / client builders ------------------------------------------------

interface FakeStoreState {
  queue: PendingDiffStatCommitWithRepo[];
  updates: Array<{ commitId: number; additions: number; deletions: number; filesChanged: number }>;
}

function makeStore(queue: PendingDiffStatCommitWithRepo[]): { store: CommitStore; state: FakeStoreState } {
  const state: FakeStoreState = { queue: [...queue], updates: [] };
  const unreachable = (): never => {
    throw new Error('CommitStore method called from tick test — unexpected');
  };
  const store: CommitStore = {
    resolveUserIdsByUuid: unreachable,
    insertCommits: unreachable,
    getSyncState: unreachable,
    markSyncRunning: unreachable,
    markSyncSuccess: unreachable,
    markSyncFailed: unreachable,
    listPendingDiffStatCommits: unreachable,
    async listPendingDiffStatCommitsGlobal(limit) {
      return state.queue.slice(0, limit);
    },
    async updateCommitDiffStats(commitId, input) {
      state.updates.push({ commitId, ...input });
    },
    getOldestCommitSha: unreachable,
    pickRepoForDeepening: unreachable,
    markDeepenAttempt: unreachable,
    markDeepenComplete: unreachable,
    updateIsMergeBatch: unreachable,
    pickRepoForIsMergeBackfill: unreachable,
    markIsMergeBackfillAttempt: unreachable,
    advanceIsMergeBackfillCursor: unreachable,
    markIsMergeBackfillComplete: unreachable,
    resetSyncCursors: unreachable,
    resetDiffStatsForRepo: unreachable,
  };
  return { store, state };
}

// Push fake timestamps into the client's private call ledger so
// `getBudgetRemaining()` reflects the desired state. Mirrors the
// pattern in commits-tick.test.ts.
function burnCalls(client: BitbucketClient, n: number): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    // @ts-expect-error — exercising the private ledger for test seeding.
    client.callTimestamps.push(now);
  }
}

interface ClientOptions {
  budget?: number;
  preBurn?: number;
  // Map of sha → diff entries to return from /diffstat, or Error to reject.
  diffByCommit?: Map<string, Array<{ lines_added: number; lines_removed: number }> | Error>;
}

function makeClient(opts: ClientOptions = {}): { client: BitbucketClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  fetchMock.mockImplementation((url: string) => {
    const sha = url.match(/\/diffstat\/([^?]+)/)?.[1];
    if (sha === undefined) throw new Error(`unexpected url: ${url}`);
    const entry = opts.diffByCommit?.get(sha);
    if (entry === undefined) throw new Error(`no fixture for sha ${sha}`);
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve(
      new Response(JSON.stringify({ pagelen: 100, values: entry }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  const client = new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@b.c',
    token: 't',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    hourlyCallBudget: opts.budget ?? 1000,
    retryBaseDelayMs: 0,
  });
  if (opts.preBurn !== undefined) burnCalls(client, opts.preBurn);
  return { client, fetchMock };
}

function commit(
  over: Partial<PendingDiffStatCommitWithRepo> & Pick<PendingDiffStatCommitWithRepo, 'id' | 'sha'>,
): PendingDiffStatCommitWithRepo {
  return {
    repositoryId: 1,
    workspace: 'tigerit',
    slug: 'r1',
    fullName: 'tigerit/r1',
    excludePatterns: [],
    authoredAt: new Date('2026-05-15T00:00:00Z'),
    ...over,
  };
}

// --- tests ------------------------------------------------------------------

describe('runDiffStatsBackfillTick', () => {
  it('no-ops cleanly when the queue is empty', async () => {
    const { store, state } = makeStore([]);
    const { client, fetchMock } = makeClient();

    const result = await runDiffStatsBackfillTick({ client, store }, { maxCommitsPerTick: 50, budgetThreshold: 10 });

    expect(result.totalUpdated).toBe(0);
    expect(result.totalFailed).toBe(0);
    expect(result.perRepo).toEqual([]);
    expect(result.stopReason).toBeNull();
    expect(state.updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drains the queue across multiple repos and aggregates per-repo totals + day ranges', async () => {
    const queue: PendingDiffStatCommitWithRepo[] = [
      commit({
        id: 11,
        sha: 'a1',
        repositoryId: 1,
        fullName: 'tigerit/r1',
        authoredAt: new Date('2026-05-15T12:00:00Z'),
      }),
      commit({
        id: 12,
        sha: 'a2',
        repositoryId: 1,
        fullName: 'tigerit/r1',
        authoredAt: new Date('2026-05-13T08:00:00Z'),
      }),
      commit({
        id: 21,
        sha: 'b1',
        repositoryId: 2,
        fullName: 'tigerit/r2',
        slug: 'r2',
        authoredAt: new Date('2026-05-14T00:00:00Z'),
      }),
    ];
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['a1', [{ lines_added: 5, lines_removed: 1 }]],
      ['a2', [{ lines_added: 2, lines_removed: 0 }]],
      ['b1', [{ lines_added: 9, lines_removed: 3 }]],
    ]);
    const { store, state } = makeStore(queue);
    const { client } = makeClient({ diffByCommit });

    const result = await runDiffStatsBackfillTick({ client, store }, { maxCommitsPerTick: 50, budgetThreshold: 10 });

    expect(result.totalUpdated).toBe(3);
    expect(result.totalFailed).toBe(0);
    expect(result.stopReason).toBeNull();

    const byRepo = new Map(result.perRepo.map((r) => [r.repositoryId, r]));
    expect(byRepo.get(1)).toMatchObject({
      updated: 2,
      failed: 0,
      range: { sinceDay: '2026-05-13', untilDay: '2026-05-15' },
    });
    expect(byRepo.get(2)).toMatchObject({
      updated: 1,
      failed: 0,
      range: { sinceDay: '2026-05-14', untilDay: '2026-05-14' },
    });
    expect(state.updates.map((u) => u.commitId).sort((a, b) => a - b)).toEqual([11, 12, 21]);
  });

  it('respects maxCommitsPerTick — the store sees only `limit` rows', async () => {
    const queue: PendingDiffStatCommitWithRepo[] = [
      commit({ id: 1, sha: 'a' }),
      commit({ id: 2, sha: 'b' }),
      commit({ id: 3, sha: 'c' }),
    ];
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['a', [{ lines_added: 1, lines_removed: 0 }]],
      ['b', [{ lines_added: 1, lines_removed: 0 }]],
    ]);
    const { store, state } = makeStore(queue);
    const listSpy = vi.spyOn(store, 'listPendingDiffStatCommitsGlobal');
    const { client } = makeClient({ diffByCommit });

    const result = await runDiffStatsBackfillTick({ client, store }, { maxCommitsPerTick: 2, budgetThreshold: 10 });

    expect(listSpy).toHaveBeenCalledWith(2);
    expect(result.totalUpdated).toBe(2);
    expect(state.updates.map((u) => u.commitId)).toEqual([1, 2]);
  });

  it('stops with stopReason=budget when the budget gate fires mid-queue', async () => {
    // budget=12, preBurn=0 → remaining=12. threshold=10. Commit 1 fits
    // (12 >= 10) and burns 1 call → remaining=11. Commit 2 fits
    // (11 >= 10) and burns 1 → remaining=10. Commit 3: 10 >= 10 still
    // fits → remaining=9. Commit 4: 9 < 10 → gate fires.
    const queue: PendingDiffStatCommitWithRepo[] = [
      commit({ id: 1, sha: 'a' }),
      commit({ id: 2, sha: 'b' }),
      commit({ id: 3, sha: 'c' }),
      commit({ id: 4, sha: 'd' }),
      commit({ id: 5, sha: 'e' }),
    ];
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['a', [{ lines_added: 1, lines_removed: 0 }]],
      ['b', [{ lines_added: 1, lines_removed: 0 }]],
      ['c', [{ lines_added: 1, lines_removed: 0 }]],
    ]);
    const { store } = makeStore(queue);
    const { client } = makeClient({ budget: 12, diffByCommit });

    const result = await runDiffStatsBackfillTick({ client, store }, { maxCommitsPerTick: 50, budgetThreshold: 10 });

    expect(result.totalUpdated).toBe(3);
    expect(result.stopReason).toBe('budget');
  });

  it('continues past a per-commit error and marks it failed', async () => {
    const queue: PendingDiffStatCommitWithRepo[] = [
      commit({ id: 1, sha: 'a' }),
      commit({ id: 2, sha: 'b' }), // bad
      commit({ id: 3, sha: 'c' }),
    ];
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }> | Error>([
      ['a', [{ lines_added: 1, lines_removed: 0 }]],
      ['b', new Error('BitBucket 500 on /diffstat/b')],
      ['c', [{ lines_added: 3, lines_removed: 1 }]],
    ]);
    const { store, state } = makeStore(queue);
    const { client } = makeClient({ diffByCommit });

    const result = await runDiffStatsBackfillTick({ client, store }, { maxCommitsPerTick: 50, budgetThreshold: 10 });

    expect(result.totalUpdated).toBe(2);
    expect(result.totalFailed).toBe(1);
    expect(result.stopReason).toBeNull();
    expect(state.updates.map((u) => u.commitId).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(result.perRepo[0]).toMatchObject({ updated: 2, failed: 1 });
  });

  it('fires rollup recompute + cache invalidation once per affected repo', async () => {
    const queue: PendingDiffStatCommitWithRepo[] = [
      commit({
        id: 11,
        sha: 'a1',
        repositoryId: 1,
        fullName: 'tigerit/r1',
        authoredAt: new Date('2026-05-15T00:00:00Z'),
      }),
      commit({
        id: 21,
        sha: 'b1',
        repositoryId: 2,
        fullName: 'tigerit/r2',
        slug: 'r2',
        authoredAt: new Date('2026-05-14T00:00:00Z'),
      }),
    ];
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['a1', [{ lines_added: 1, lines_removed: 0 }]],
      ['b1', [{ lines_added: 1, lines_removed: 0 }]],
    ]);
    const { store } = makeStore(queue);
    const { client } = makeClient({ diffByCommit });

    const recomputed: Array<{ repositoryId: number; range: unknown }> = [];
    const invalidated: number[] = [];
    const rollupStore: RollupStore = {
      async recomputeCommitDailyForRepo(repositoryId, range) {
        recomputed.push({ repositoryId, range });
        return { rowsAffected: 1 };
      },
      async listAffectedUserIdsForRepo(repositoryId) {
        return repositoryId === 1 ? [101, 102] : [201];
      },
      async rebuildAll() {
        throw new Error('not used in this test');
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

    await runDiffStatsBackfillTick(
      { client, store, rollupStore, userSummaryCache },
      { maxCommitsPerTick: 50, budgetThreshold: 10 },
    );

    expect(recomputed.sort((a, b) => a.repositoryId - b.repositoryId)).toEqual([
      { repositoryId: 1, range: { sinceDay: '2026-05-15', untilDay: '2026-05-15' } },
      { repositoryId: 2, range: { sinceDay: '2026-05-14', untilDay: '2026-05-14' } },
    ]);
    expect(invalidated.sort((a, b) => a - b)).toEqual([101, 102, 201]);
  });

  it('swallows rollup-step errors — the tick still returns a clean result', async () => {
    const queue: PendingDiffStatCommitWithRepo[] = [commit({ id: 1, sha: 'a' })];
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['a', [{ lines_added: 1, lines_removed: 0 }]],
    ]);
    const { store } = makeStore(queue);
    const { client } = makeClient({ diffByCommit });

    const rollupStore: RollupStore = {
      async recomputeCommitDailyForRepo() {
        throw new Error('rollup boom');
      },
      async listAffectedUserIdsForRepo() {
        return [];
      },
      async rebuildAll() {
        throw new Error('not used');
      },
    };

    const result = await runDiffStatsBackfillTick(
      { client, store, rollupStore },
      { maxCommitsPerTick: 50, budgetThreshold: 10 },
    );

    expect(result.totalUpdated).toBe(1);
    expect(result.totalFailed).toBe(0);
  });
});
