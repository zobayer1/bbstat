import { describe, expect, it, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { CommitStore, PendingDiffStatCommit } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';
import { syncRepositoryDiffStats } from './diff-stats.js';

function makeRepo(over: Partial<RepositoryHandle> = {}): RepositoryHandle {
  return {
    repositoryId: 1,
    workspace: 'tigerit',
    slug: 'r',
    fullName: 'tigerit/r',
    diffStatsEnabled: true,
    ...over,
  };
}

interface FakeState {
  pending: PendingDiffStatCommit[];
  updates: Array<{ commitId: number; additions: number; deletions: number; filesChanged: number }>;
}

function makeStore(pending: PendingDiffStatCommit[] = []): { store: CommitStore; state: FakeState } {
  const state: FakeState = { pending: [...pending], updates: [] };
  const unreachable = (): never => {
    throw new Error('CommitStore method called from diff-stats test — unexpected');
  };
  const store: CommitStore = {
    resolveUserIdsByUuid: unreachable,
    insertCommits: unreachable,
    getSyncState: unreachable,
    markSyncRunning: unreachable,
    markSyncSuccess: unreachable,
    markSyncFailed: unreachable,
    async listPendingDiffStatCommits(_repositoryId, limit) {
      return state.pending.slice(0, limit);
    },
    async updateCommitDiffStats(commitId, input) {
      state.updates.push({ commitId, ...input });
      state.pending = state.pending.filter((c) => c.id !== commitId);
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
  };
  return { store, state };
}

interface FetchMockSetup {
  fetch: ReturnType<typeof vi.fn>;
  // Map sha → response body to return for that commit's diffstat call.
  diffByCommit: Map<string, Array<{ lines_added: number; lines_removed: number }> | Error>;
}

function makeClientWithDiffstat(setup: FetchMockSetup, budget = 1000): BitbucketClient {
  setup.fetch.mockImplementation((url: string) => {
    const sha = url.match(/\/diffstat\/([^?]+)/)?.[1];
    if (sha === undefined) throw new Error(`unexpected url: ${url}`);
    const entry = setup.diffByCommit.get(sha);
    if (entry instanceof Error) return Promise.reject(entry);
    if (entry === undefined) throw new Error(`no fixture for sha ${sha}`);
    return Promise.resolve(
      new Response(JSON.stringify({ pagelen: 100, values: entry }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@b.c',
    token: 't',
    fetch: setup.fetch as unknown as typeof globalThis.fetch,
    hourlyCallBudget: budget,
    retryBaseDelayMs: 0,
  });
}

describe('syncRepositoryDiffStats', () => {
  it('short-circuits when repo.diffStatsEnabled is false — no DB read, no BB call', async () => {
    const fetchMock = vi.fn();
    const { store, state } = makeStore([{ id: 1, sha: 'a', authoredAt: new Date('2026-05-01T00:00:00Z') }]);
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit: new Map() });

    const result = await syncRepositoryDiffStats({ client, store }, makeRepo({ diffStatsEnabled: false }), {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result).toEqual({ updated: 0, failed: 0, deferred: 0, hitBudgetGate: false, diffStatsRange: null });
    expect(state.updates).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty when no pending commits — no BB call', async () => {
    const fetchMock = vi.fn();
    const { store } = makeStore([]);
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit: new Map() });

    const result = await syncRepositoryDiffStats({ client, store }, makeRepo(), {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.updated).toBe(0);
    expect(result.diffStatsRange).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches and persists diff stats for each pending commit', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['sha-a', [{ lines_added: 5, lines_removed: 1 }]],
      ['sha-b', [{ lines_added: 10, lines_removed: 3 }]],
    ]);
    const { store, state } = makeStore([
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-05T12:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-03T08:00:00Z') },
    ]);
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit });

    const result = await syncRepositoryDiffStats({ client, store }, makeRepo(), {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.hitBudgetGate).toBe(false);
    // Range covers both days.
    expect(result.diffStatsRange).toEqual({ sinceDay: '2026-05-03', untilDay: '2026-05-05' });
    expect(state.updates).toEqual([
      { commitId: 1, additions: 5, deletions: 1, filesChanged: 1 },
      { commitId: 2, additions: 10, deletions: 3, filesChanged: 1 },
    ]);
  });

  it('stops scheduling when getBudgetRemaining drops below threshold', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['sha-a', [{ lines_added: 1, lines_removed: 0 }]],
      // sha-b and sha-c never get called — budget exhausted before they run.
    ]);
    const { store, state } = makeStore([
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-05T00:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-05T00:00:00Z') },
      { id: 3, sha: 'sha-c', authoredAt: new Date('2026-05-05T00:00:00Z') },
    ]);
    // budget=11, threshold=10 → only one fetch fits before budget=10 (gate trips).
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit }, 11);

    const result = await syncRepositoryDiffStats({ client, store }, makeRepo(), {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.updated).toBe(1);
    expect(result.hitBudgetGate).toBe(true);
    expect(state.updates).toEqual([{ commitId: 1, additions: 1, deletions: 0, filesChanged: 1 }]);
    // Two commits stayed pending in the store — they'll be retried next tick.
    expect(state.pending.map((c) => c.id)).toEqual([2, 3]);
  });

  it('continues past a per-commit fetch error, leaving the bad commit pending', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }> | Error>([
      ['sha-a', [{ lines_added: 2, lines_removed: 1 }]],
      // BB returns 4xx for this one — wrapper throws BitbucketApiError.
      ['sha-b', new Error('BitBucket 400 on /diffstat/sha-b')],
      ['sha-c', [{ lines_added: 7, lines_removed: 4 }]],
    ]);
    const { store, state } = makeStore([
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-04T00:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-04T00:00:00Z') },
      { id: 3, sha: 'sha-c', authoredAt: new Date('2026-05-04T00:00:00Z') },
    ]);
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit });

    const result = await syncRepositoryDiffStats({ client, store }, makeRepo(), {
      maxPerRepoPerTick: 50,
      budgetThreshold: 10,
    });

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(1);
    expect(state.updates.map((u) => u.commitId).sort()).toEqual([1, 3]);
    // The failed commit stays pending for the next tick.
    expect(state.pending.map((c) => c.id)).toEqual([2]);
  });

  it('respects maxPerRepoPerTick — the store only returns up to that many', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['sha-a', [{ lines_added: 1, lines_removed: 0 }]],
      ['sha-b', [{ lines_added: 1, lines_removed: 0 }]],
    ]);
    const { store } = makeStore([
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-05T00:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-05T00:00:00Z') },
      { id: 3, sha: 'sha-c', authoredAt: new Date('2026-05-05T00:00:00Z') },
    ]);
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit });

    const result = await syncRepositoryDiffStats({ client, store }, makeRepo(), {
      maxPerRepoPerTick: 2,
      budgetThreshold: 10,
    });

    expect(result.updated).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
