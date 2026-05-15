// Unit tests for the inline-eager forward path
// (`fetchDiffStatsForCommits`). The backfill orchestrator that used to
// live in this file's sibling test (`syncRepositoryDiffStats`) was
// removed in 2026-05 when diff-stat ingest moved to global newest-first
// pickup — see diff-stats-tick.test.ts for the new orchestrator's
// coverage.

import { describe, expect, it, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { CommitStore, PendingDiffStatCommit } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';
import { fetchDiffStatsForCommits } from './diff-stats.js';

function makeRepo(over: Partial<RepositoryHandle> = {}): RepositoryHandle {
  return {
    repositoryId: 1,
    workspace: 'tigerit',
    slug: 'r',
    fullName: 'tigerit/r',
    diffStatsExcludePatterns: [],
    ...over,
  };
}

interface FakeState {
  updates: Array<{ commitId: number; additions: number; deletions: number; filesChanged: number }>;
}

function makeStore(): { store: CommitStore; state: FakeState } {
  const state: FakeState = { updates: [] };
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
    listPendingDiffStatCommits: unreachable,
    listPendingDiffStatCommitsGlobal: unreachable,
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

interface FetchMockSetup {
  fetch: ReturnType<typeof vi.fn>;
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

describe('fetchDiffStatsForCommits', () => {
  it('returns empty for an empty commits list — no BB call', async () => {
    const fetchMock = vi.fn();
    const { store } = makeStore();
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit: new Map() });

    const result = await fetchDiffStatsForCommits({ client, store }, makeRepo(), [], { budgetThreshold: 10 });

    expect(result).toEqual({ updated: 0, failed: 0, deferred: 0, hitBudgetGate: false, diffStatsRange: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches and persists diff stats for each commit', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['sha-a', [{ lines_added: 5, lines_removed: 1 }]],
      ['sha-b', [{ lines_added: 10, lines_removed: 3 }]],
    ]);
    const { store, state } = makeStore();
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit });
    const commits: PendingDiffStatCommit[] = [
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-05T12:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-03T08:00:00Z') },
    ];

    const result = await fetchDiffStatsForCommits({ client, store }, makeRepo(), commits, { budgetThreshold: 10 });

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.hitBudgetGate).toBe(false);
    expect(result.diffStatsRange).toEqual({ sinceDay: '2026-05-03', untilDay: '2026-05-05' });
    expect(state.updates).toEqual([
      { commitId: 1, additions: 5, deletions: 1, filesChanged: 1 },
      { commitId: 2, additions: 10, deletions: 3, filesChanged: 1 },
    ]);
  });

  it('stops scheduling when budget falls below threshold', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }>>([
      ['sha-a', [{ lines_added: 1, lines_removed: 0 }]],
    ]);
    const { store, state } = makeStore();
    // budget=11, threshold=10 → only one fetch fits.
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit }, 11);
    const commits: PendingDiffStatCommit[] = [
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-05T00:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-05T00:00:00Z') },
      { id: 3, sha: 'sha-c', authoredAt: new Date('2026-05-05T00:00:00Z') },
    ];

    const result = await fetchDiffStatsForCommits({ client, store }, makeRepo(), commits, { budgetThreshold: 10 });

    expect(result.updated).toBe(1);
    expect(result.hitBudgetGate).toBe(true);
    expect(state.updates).toEqual([{ commitId: 1, additions: 1, deletions: 0, filesChanged: 1 }]);
  });

  it('continues past a per-commit fetch error, leaving the bad commit failed', async () => {
    const fetchMock = vi.fn();
    const diffByCommit = new Map<string, Array<{ lines_added: number; lines_removed: number }> | Error>([
      ['sha-a', [{ lines_added: 2, lines_removed: 1 }]],
      ['sha-b', new Error('BitBucket 400 on /diffstat/sha-b')],
      ['sha-c', [{ lines_added: 7, lines_removed: 4 }]],
    ]);
    const { store, state } = makeStore();
    const client = makeClientWithDiffstat({ fetch: fetchMock, diffByCommit });
    const commits: PendingDiffStatCommit[] = [
      { id: 1, sha: 'sha-a', authoredAt: new Date('2026-05-04T00:00:00Z') },
      { id: 2, sha: 'sha-b', authoredAt: new Date('2026-05-04T00:00:00Z') },
      { id: 3, sha: 'sha-c', authoredAt: new Date('2026-05-04T00:00:00Z') },
    ];

    const result = await fetchDiffStatsForCommits({ client, store }, makeRepo(), commits, { budgetThreshold: 10 });

    expect(result.updated).toBe(2);
    expect(result.failed).toBe(1);
    expect(state.updates.map((u) => u.commitId).sort((a, b) => a - b)).toEqual([1, 3]);
  });
});
