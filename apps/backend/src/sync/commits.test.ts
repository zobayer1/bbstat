import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { BitbucketCommit } from '../bitbucket/commits.js';
import {
  type CommitInsertInput,
  type CommitStore,
  type PendingDiffStatCommit,
  type SyncStateRow,
  type SyncSuccessUpdate,
} from './commit-store.js';
import { syncRepositoryCommits, type RepositoryHandle } from './commits.js';

// ---------------------------------------------------------------------------
// In-memory fake of CommitStore. Mirrors discovery.test.ts's pattern: enough
// behavior to verify the domain logic in commits.ts without spinning up Postgres.
// ---------------------------------------------------------------------------

interface FakeCommitStoreState {
  commits: Map<string, CommitInsertInput>; // by `${repoId}:${sha}`
  syncStateByRepo: Map<number, SyncStateRow>;
  usersByUuid: Map<string, number>;
  markRunningCalls: number[]; // repositoryId, in order
  markSuccessCalls: Array<{ repositoryId: number; update: SyncSuccessUpdate }>;
  markFailedCalls: Array<{ repositoryId: number; error: string }>;
  // Phase 4 T21: pending-diff-stat commits keyed by id; populated by tests
  // that want to exercise the diff-stats path.
  pendingDiffStatCommits: Map<number, PendingDiffStatCommit>;
  diffStatsUpdates: Array<{ commitId: number; additions: number; deletions: number }>;
}

function createFakeCommitStore(seed?: { syncState?: SyncStateRow[]; users?: Array<[string, number]> }): {
  store: CommitStore;
  state: FakeCommitStoreState;
} {
  const state: FakeCommitStoreState = {
    commits: new Map(),
    syncStateByRepo: new Map(),
    usersByUuid: new Map(),
    markRunningCalls: [],
    markSuccessCalls: [],
    markFailedCalls: [],
    pendingDiffStatCommits: new Map(),
    diffStatsUpdates: [],
  };
  for (const row of seed?.syncState ?? []) state.syncStateByRepo.set(row.repositoryId, row);
  for (const [uuid, id] of seed?.users ?? []) state.usersByUuid.set(uuid, id);

  const store: CommitStore = {
    async resolveUserIdsByUuid(uuids) {
      const map = new Map<string, number>();
      for (const u of uuids) {
        const id = state.usersByUuid.get(u);
        if (id !== undefined) map.set(u, id);
      }
      return map;
    },
    async insertCommits(input) {
      let inserted = 0;
      for (const c of input) {
        const key = `${c.repositoryId}:${c.sha}`;
        if (!state.commits.has(key)) {
          state.commits.set(key, c);
          inserted++;
        }
      }
      return { inserted };
    },
    async getSyncState(repositoryId) {
      return state.syncStateByRepo.get(repositoryId) ?? null;
    },
    async markSyncRunning(repositoryId) {
      state.markRunningCalls.push(repositoryId);
      const row = state.syncStateByRepo.get(repositoryId);
      if (row) {
        state.syncStateByRepo.set(repositoryId, {
          ...row,
          lastSyncStatus: 'running',
          lastSyncStartedAt: new Date(),
        });
      }
    },
    async markSyncSuccess(repositoryId, update) {
      state.markSuccessCalls.push({ repositoryId, update });
      const row = state.syncStateByRepo.get(repositoryId);
      if (row) {
        state.syncStateByRepo.set(repositoryId, {
          ...row,
          lastSyncStatus: 'success',
          lastSyncedAt: new Date(),
          lastSyncError: null,
          // mirror Drizzle impl: leave cursor untouched when null
          ...(update.lastSeenSha !== null ? { lastSeenSha: update.lastSeenSha } : {}),
          totalCommitsSynced: row.totalCommitsSynced + update.commitsAdded,
        });
      }
    },
    async markSyncFailed(repositoryId, error) {
      state.markFailedCalls.push({ repositoryId, error });
      const row = state.syncStateByRepo.get(repositoryId);
      if (row) {
        state.syncStateByRepo.set(repositoryId, { ...row, lastSyncStatus: 'failed', lastSyncError: error });
      }
    },
    async listPendingDiffStatCommits(_repositoryId, limit) {
      return Array.from(state.pendingDiffStatCommits.values()).slice(0, limit);
    },
    async updateCommitDiffStats(commitId, input) {
      state.diffStatsUpdates.push({ commitId, ...input });
      state.pendingDiffStatCommits.delete(commitId);
    },
  };

  return { store, state };
}

// ---------------------------------------------------------------------------
// Fixtures + HTTP helpers
// ---------------------------------------------------------------------------

function makeRepo(repositoryId: number, slug = 'boing-server'): RepositoryHandle {
  return { repositoryId, workspace: 'tigerit', slug, fullName: `tigerit/${slug}`, diffStatsEnabled: false };
}

function makeSyncStateRow(repositoryId: number, lastSeenSha: string | null = null): SyncStateRow {
  return {
    repositoryId,
    lastSeenSha,
    lastSyncedAt: null,
    lastSyncStartedAt: null,
    lastSyncStatus: 'idle',
    lastSyncError: null,
    totalCommitsSynced: 0,
  };
}

function makeCommit(
  hash: string,
  opts: { date?: string; user?: { uuid: string; display_name?: string } } = {},
): BitbucketCommit {
  return {
    hash,
    message: `commit ${hash}`,
    date: opts.date ?? '2026-05-01T00:00:00+00:00',
    parents: [],
    author: {
      raw: 'Author <author@example.com>',
      ...(opts.user ? { user: opts.user } : {}),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function commitsPage(values: BitbucketCommit[], next?: string): Response {
  return jsonResponse({ pagelen: 100, values, ...(next !== undefined ? { next } : {}) });
}

function makeClient(fetchFn: typeof globalThis.fetch): BitbucketClient {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'alice@example.com',
    token: 'tok',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
  });
}

// Generates `count` commits with hashes "sha-{i}" newest first (i=0 is newest).
function manyCommits(count: number, opts: { startDate?: Date } = {}): BitbucketCommit[] {
  const start = opts.startDate?.getTime() ?? new Date('2026-05-01T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) =>
    makeCommit(`sha-${i}`, { date: new Date(start - i * 86_400_000).toISOString() }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncRepositoryCommits — no sync_state row', () => {
  it("returns mode='no-state' and does not touch the API", async () => {
    const fetchMock = vi.fn();
    const { store, state } = createFakeCommitStore();
    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(result.mode).toBe('no-state');
    expect(result.fetched).toBe(0);
    expect(result.inserted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.markRunningCalls).toEqual([]);
    expect(state.markSuccessCalls).toEqual([]);
  });
});

describe('syncRepositoryCommits — cold mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('empty repo: marks success with no cursor change, no inserts', async () => {
    fetchMock.mockResolvedValueOnce(commitsPage([]));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(result).toMatchObject({ mode: 'cold', fetched: 0, inserted: 0, newCursor: null });
    expect(state.markSuccessCalls).toEqual([{ repositoryId: 1, update: { lastSeenSha: null, commitsAdded: 0 } }]);
    expect(state.syncStateByRepo.get(1)?.lastSeenSha).toBeNull();
    expect(state.syncStateByRepo.get(1)?.lastSyncStatus).toBe('success');
  });

  it('small repo: inserts every commit and sets cursor to the newest', async () => {
    const commits = [makeCommit('sha-newest'), makeCommit('sha-mid'), makeCommit('sha-oldest')];
    fetchMock.mockResolvedValueOnce(commitsPage(commits));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(result).toMatchObject({ mode: 'cold', fetched: 3, inserted: 3, newCursor: 'sha-newest' });
    expect(state.commits.size).toBe(3);
    expect(state.syncStateByRepo.get(1)?.lastSeenSha).toBe('sha-newest');
    expect(state.syncStateByRepo.get(1)?.totalCommitsSynced).toBe(3);
  });

  it('respects firstRunMaxPages — stops after pages × 100 commits', async () => {
    // 2 pages of 100, then a third we should never reach.
    fetchMock
      .mockResolvedValueOnce(
        commitsPage(manyCommits(100), 'https://api.bitbucket.org/2.0/repositories/tigerit/boing-server/commits?page=2'),
      )
      .mockResolvedValueOnce(
        commitsPage(
          manyCommits(100).map((c, i) => ({ ...c, hash: `p2-${i}` })),
          'https://api.bitbucket.org/2.0/repositories/tigerit/boing-server/commits?page=3',
        ),
      )
      .mockResolvedValueOnce(commitsPage(manyCommits(100).map((c, i) => ({ ...c, hash: `p3-${i}` }))));
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
      { firstRunMaxPages: 2 },
    );

    expect(result).toMatchObject({ fetched: 200, inserted: 200, hitPageCap: true, hitKnownSha: false });
    expect(fetchMock).toHaveBeenCalledTimes(2); // page 3 never fetched
  });

  it('respects firstRunSince — stops at first commit older than the cutoff', async () => {
    const cutoff = new Date('2026-04-15T00:00:00Z');
    // Newest first: 5 recent (after cutoff), then 5 old (before cutoff).
    const commits = [
      ...Array.from({ length: 5 }, (_, i) => makeCommit(`new-${i}`, { date: '2026-05-01T00:00:00+00:00' })),
      ...Array.from({ length: 5 }, (_, i) => makeCommit(`old-${i}`, { date: '2026-04-01T00:00:00+00:00' })),
    ];
    fetchMock.mockResolvedValueOnce(commitsPage(commits));
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
      { firstRunSince: cutoff },
    );

    expect(result).toMatchObject({ fetched: 5, inserted: 5, hitDateCap: true, newCursor: 'new-0' });
  });

  it('resolves authors: matched user, unmatched UUID, anonymous (no user)', async () => {
    const commits = [
      makeCommit('sha-known', { user: { uuid: '{u1}', display_name: 'Alice' } }),
      makeCommit('sha-unknown', { user: { uuid: '{u-missing}', display_name: 'Stranger' } }),
      makeCommit('sha-anon'), // no author.user
    ];
    fetchMock.mockResolvedValueOnce(commitsPage(commits));
    const { store, state } = createFakeCommitStore({
      syncState: [makeSyncStateRow(1)],
      users: [['{u1}', 42]],
    });

    await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(state.commits.get('1:sha-known')?.authorUserId).toBe(42);
    expect(state.commits.get('1:sha-unknown')?.authorUserId).toBeNull();
    expect(state.commits.get('1:sha-anon')?.authorUserId).toBeNull();
  });
});

describe('syncRepositoryCommits — delta mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('idle repo (cursor matches first returned commit): no inserts, cursor preserved, single fetch', async () => {
    fetchMock.mockResolvedValueOnce(commitsPage([makeCommit('sha-cursor')]));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(result).toMatchObject({ mode: 'delta', fetched: 0, inserted: 0, hitKnownSha: true, newCursor: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.syncStateByRepo.get(1)?.lastSeenSha).toBe('sha-cursor');
    expect(state.syncStateByRepo.get(1)?.lastSyncStatus).toBe('success');
  });

  it('some new commits: walks until known sha, advances cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      commitsPage([makeCommit('sha-new-1'), makeCommit('sha-new-2'), makeCommit('sha-cursor'), makeCommit('sha-old')]),
    );
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(result).toMatchObject({ mode: 'delta', fetched: 2, inserted: 2, hitKnownSha: true, newCursor: 'sha-new-1' });
    expect(state.commits.has('1:sha-new-1')).toBe(true);
    expect(state.commits.has('1:sha-new-2')).toBe(true);
    expect(state.commits.has('1:sha-cursor')).toBe(false); // never inserted
    expect(state.syncStateByRepo.get(1)?.lastSeenSha).toBe('sha-new-1');
  });

  it('cursor orphaned (force-push) walks the full history; firstRunMaxPages does NOT apply to delta', async () => {
    // 250 commits across 3 pages, none matching the orphaned cursor.
    fetchMock
      .mockResolvedValueOnce(
        commitsPage(manyCommits(100), 'https://api.bitbucket.org/2.0/repositories/tigerit/boing-server/commits?page=2'),
      )
      .mockResolvedValueOnce(
        commitsPage(
          manyCommits(100).map((c, i) => ({ ...c, hash: `p2-${i}` })),
          'https://api.bitbucket.org/2.0/repositories/tigerit/boing-server/commits?page=3',
        ),
      )
      .mockResolvedValueOnce(commitsPage(manyCommits(50).map((c, i) => ({ ...c, hash: `p3-${i}` }))));
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-orphaned')] });

    const result = await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
      { firstRunMaxPages: 1 }, // intentionally tight — must not apply to delta
    );

    expect(result).toMatchObject({ mode: 'delta', fetched: 250, inserted: 250, hitKnownSha: false, hitPageCap: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('syncRepositoryCommits — idempotency + failure', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('rerunning a cold sync does not double-count (insertCommits dedupes)', async () => {
    const commits = [makeCommit('sha-a'), makeCommit('sha-b')];
    // mint a fresh Response per call — Response bodies are single-use.
    fetchMock.mockImplementation(() => Promise.resolve(commitsPage(commits)));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncRepositoryCommits(deps, makeRepo(1));
    // Wipe cursor to force a second cold run — simulates the race we tolerate.
    const row = state.syncStateByRepo.get(1)!;
    state.syncStateByRepo.set(1, { ...row, lastSeenSha: null });

    const second = await syncRepositoryCommits(deps, makeRepo(1));

    expect(second.fetched).toBe(2);
    expect(second.inserted).toBe(0); // both already present
    expect(state.commits.size).toBe(2);
    expect(state.syncStateByRepo.get(1)?.totalCommitsSynced).toBe(2); // first run only
  });

  it('on pull failure: marks failed and rethrows', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500)));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await expect(syncRepositoryCommits(deps, makeRepo(1))).rejects.toThrow();
    expect(state.markFailedCalls).toHaveLength(1);
    expect(state.markFailedCalls[0]?.repositoryId).toBe(1);
    expect(state.syncStateByRepo.get(1)?.lastSyncStatus).toBe('failed');
    expect(state.markSuccessCalls).toEqual([]);
  });
});

describe('syncRepositoryCommits — diff-stats integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function repoWithDiffStats(): RepositoryHandle {
    return { ...makeRepo(1), diffStatsEnabled: true };
  }

  it('runs the diff-stats step on opt-in repos when opts.diffStats is supplied', async () => {
    // First call: empty commits page (delta with cursor). Second call:
    // /diffstat/sha-pending — returns a single file with +12 / -3.
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(commitsPage([])))
      .mockImplementationOnce(() =>
        Promise.resolve(jsonResponse({ pagelen: 100, values: [{ lines_added: 12, lines_removed: 3 }] })),
      );
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    // Pre-seed one pending commit; the diff-stats worker will pick it up.
    state.pendingDiffStatCommits.set(99, {
      id: 99,
      sha: 'sha-pending',
      authoredAt: new Date('2026-05-04T12:00:00Z'),
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {
      diffStats: { maxPerRepoPerTick: 50, budgetThreshold: 10 },
    });

    expect(result.diffStatsUpdated).toBe(1);
    expect(result.diffStatsFailed).toBe(0);
    expect(result.diffStatsRange).toEqual({ sinceDay: '2026-05-04', untilDay: '2026-05-04' });
    expect(state.diffStatsUpdates).toEqual([{ commitId: 99, additions: 12, deletions: 3 }]);
  });

  it('skips the diff-stats step on opt-out repos even when opts.diffStats is supplied', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(commitsPage([])));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    state.pendingDiffStatCommits.set(99, {
      id: 99,
      sha: 'sha-pending',
      authoredAt: new Date('2026-05-04T12:00:00Z'),
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(
      deps,
      makeRepo(1), // diffStatsEnabled defaults to false
      { diffStats: { maxPerRepoPerTick: 50, budgetThreshold: 10 } },
    );

    expect(result.diffStatsUpdated).toBe(0);
    expect(result.diffStatsRange).toBeNull();
    expect(state.diffStatsUpdates).toHaveLength(0);
    // Only the commits-list call was made; no /diffstat fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the diff-stats step when opts.diffStats is omitted, even on opt-in repos', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(commitsPage([])));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    state.pendingDiffStatCommits.set(99, {
      id: 99,
      sha: 'sha-pending',
      authoredAt: new Date('2026-05-04T12:00:00Z'),
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {});

    expect(result.diffStatsUpdated).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poison the commit-sync result when diff-stats throws unexpectedly', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(commitsPage([])));
    const { state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    // Override the store to make the pickup query throw.
    const brokenStore: CommitStore = {
      resolveUserIdsByUuid: async () => new Map(),
      insertCommits: async () => ({ inserted: 0 }),
      getSyncState: async () => state.syncStateByRepo.get(1) ?? null,
      markSyncRunning: async () => {},
      markSyncSuccess: async (id, update) => {
        state.markSuccessCalls.push({ repositoryId: id, update });
      },
      markSyncFailed: async () => {},
      listPendingDiffStatCommits: async () => {
        throw new Error('pickup blew up');
      },
      updateCommitDiffStats: async () => {},
    };
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store: brokenStore };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {
      diffStats: { maxPerRepoPerTick: 50, budgetThreshold: 10 },
    });

    // The commit-sync portion still succeeded.
    expect(state.markSuccessCalls).toHaveLength(1);
    expect(result.diffStatsUpdated).toBe(0);
    expect(result.diffStatsRange).toBeNull();
  });
});
