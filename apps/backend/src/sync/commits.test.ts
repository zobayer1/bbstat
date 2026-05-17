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
  // Synthesized serial id per inserted commit (mirrors Drizzle's
  // SERIAL primary key). Returned to callers in `insertCommits` so
  // the inline-eager diff-stats path can walk just-inserted rows.
  idBySha: Map<string, number>;
  idSeq: number;
  syncStateByRepo: Map<number, SyncStateRow>;
  usersByUuid: Map<string, number>;
  // Mirrors users.email — write-once semantics enforced in
  // setUserEmailsIfMissing below so tests can assert capture behavior.
  emailsByUuid: Map<string, string>;
  markRunningCalls: number[]; // repositoryId, in order
  markSuccessCalls: Array<{ repositoryId: number; update: SyncSuccessUpdate }>;
  markFailedCalls: Array<{ repositoryId: number; error: string }>;
  // Phase 4 T21: pending-diff-stat commits keyed by id. Used by the
  // *backfill* path; inline-eager no longer reads from here (kept so
  // tests can assert inline-eager *doesn't* pick these up).
  pendingDiffStatCommits: Map<number, PendingDiffStatCommit>;
  diffStatsUpdates: Array<{ commitId: number; additions: number; deletions: number; filesChanged: number }>;
}

function createFakeCommitStore(seed?: { syncState?: SyncStateRow[]; users?: Array<[string, number]> }): {
  store: CommitStore;
  state: FakeCommitStoreState;
} {
  const state: FakeCommitStoreState = {
    commits: new Map(),
    idBySha: new Map(),
    idSeq: 0,
    syncStateByRepo: new Map(),
    usersByUuid: new Map(),
    emailsByUuid: new Map(),
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
    async setUserEmailsIfMissing(entries) {
      for (const e of entries) {
        if (!state.usersByUuid.has(e.bitbucketUuid)) continue;
        if (state.emailsByUuid.has(e.bitbucketUuid)) continue;
        state.emailsByUuid.set(e.bitbucketUuid, e.email);
      }
    },
    async listUsersMissingEmailWithLastCommit() {
      // Not exercised by these per-repo sync tests — the admin email
      // backfill endpoint is the only caller, and its tests live in
      // tests/admin.test.ts.
      return [];
    },
    async insertCommits(input) {
      const insertedRows: Array<{ id: number; sha: string; authoredAt: Date }> = [];
      for (const c of input) {
        const key = `${c.repositoryId}:${c.sha}`;
        if (!state.commits.has(key)) {
          state.commits.set(key, c);
          const id = ++state.idSeq;
          state.idBySha.set(key, id);
          insertedRows.push({ id, sha: c.sha, authoredAt: c.authoredAt });
        }
      }
      return { inserted: insertedRows.length, insertedRows };
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
    async listPendingDiffStatCommitsGlobal() {
      // Inline-eager path doesn't drive global pickup — tests in this
      // file never exercise it.
      return [];
    },
    async updateCommitDiffStats(commitId, input) {
      state.diffStatsUpdates.push({ commitId, ...input });
      state.pendingDiffStatCommits.delete(commitId);
    },
    async getOldestCommitSha() {
      // Tests in this file don't exercise deepen-backfill — return null
      // unless a future test sets `state.oldestShaOverride`.
      return null;
    },
    async pickRepoForDeepening() {
      return null;
    },
    async markDeepenAttempt() {},
    async markDeepenComplete() {},
    async updateIsMergeBatch(_repositoryId, entries) {
      return { updated: entries.length };
    },
    async pickRepoForIsMergeBackfill() {
      return null;
    },
    async markIsMergeBackfillAttempt() {},
    async advanceIsMergeBackfillCursor() {},
    async markIsMergeBackfillComplete() {},
    async resetSyncCursors() {},
    async resetDiffStatsForRepo() {
      return { resetCount: 0 };
    },
  };

  return { store, state };
}

// ---------------------------------------------------------------------------
// Fixtures + HTTP helpers
// ---------------------------------------------------------------------------

function makeRepo(repositoryId: number, slug = 'boing-server'): RepositoryHandle {
  return {
    repositoryId,
    workspace: 'tigerit',
    slug,
    fullName: `tigerit/${slug}`,
    diffStatsExcludePatterns: [],
  };
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
  opts: {
    date?: string;
    user?: { uuid: string; display_name?: string };
    parents?: Array<{ hash: string }>;
  } = {},
): BitbucketCommit {
  return {
    hash,
    message: `commit ${hash}`,
    date: opts.date ?? '2026-05-01T00:00:00+00:00',
    parents: opts.parents ?? [],
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

  it('captures isMerge from BB parents.length > 1', async () => {
    const commits = [
      makeCommit('sha-normal', { parents: [{ hash: 'p1' }] }),
      makeCommit('sha-merge', { parents: [{ hash: 'p1' }, { hash: 'p2' }] }),
      makeCommit('sha-initial', { parents: [] }),
    ];
    fetchMock.mockResolvedValueOnce(commitsPage(commits));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(state.commits.get('1:sha-normal')?.isMerge).toBe(false);
    expect(state.commits.get('1:sha-merge')?.isMerge).toBe(true);
    expect(state.commits.get('1:sha-initial')?.isMerge).toBe(false);
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

describe('syncRepositoryCommits — inline-eager diff-stats', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function repoWithDiffStats(): RepositoryHandle {
    return makeRepo(1);
  }

  it('fetches /diffstat for commits just inserted in this run', async () => {
    // BB delta returns one new commit; the inline-eager step then
    // fetches /diffstat for that sha.
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(commitsPage([makeCommit('sha-new', { date: '2026-05-04T12:00:00+00:00' })])),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(jsonResponse({ pagelen: 100, values: [{ lines_added: 12, lines_removed: 3 }] })),
      );
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {
      diffStats: { budgetThreshold: 10 },
    });

    expect(result.inserted).toBe(1);
    expect(result.diffStatsUpdated).toBe(1);
    expect(result.diffStatsFailed).toBe(0);
    expect(result.diffStatsRange).toEqual({ sinceDay: '2026-05-04', untilDay: '2026-05-04' });
    // commitId is the synthesized id from the fake store's idSeq.
    const expectedId = state.idBySha.get('1:sha-new')!;
    expect(state.diffStatsUpdates).toEqual([{ commitId: expectedId, additions: 12, deletions: 3, filesChanged: 1 }]);
  });

  it('does NOT pick up older pending commits (those are the backfill tick’s job)', async () => {
    // BB delta returns nothing new; pre-seeded pending commits from a
    // past run should be ignored by inline-eager.
    fetchMock.mockImplementationOnce(() => Promise.resolve(commitsPage([])));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    state.pendingDiffStatCommits.set(99, {
      id: 99,
      sha: 'sha-stale-pending',
      authoredAt: new Date('2026-04-15T00:00:00Z'),
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {
      diffStats: { budgetThreshold: 10 },
    });

    expect(result.diffStatsUpdated).toBe(0);
    expect(state.diffStatsUpdates).toHaveLength(0);
    // Only the commits-list call was made; no /diffstat fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the diff-stats step when opts.diffStats is omitted (runner gate off)', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(commitsPage([makeCommit('sha-new', { date: '2026-05-04T12:00:00+00:00' })])),
    );
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {});

    expect(result.diffStatsUpdated).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poison the commit-sync result when diff-stats fetch throws', async () => {
    // Insert succeeds, but /diffstat returns 500.
    fetchMock
      .mockImplementationOnce(() =>
        Promise.resolve(commitsPage([makeCommit('sha-new', { date: '2026-05-04T12:00:00+00:00' })])),
      )
      .mockImplementation(() => Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500)));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryCommits(deps, repoWithDiffStats(), {
      diffStats: { budgetThreshold: 10 },
    });

    // Commit-sync portion still succeeded — the commit is in the table,
    // markSyncSuccess fired. The per-commit fetch failed and the row
    // stays pending; the backfill tick will retry.
    expect(state.markSuccessCalls).toHaveLength(1);
    expect(result.inserted).toBe(1);
    expect(result.diffStatsUpdated).toBe(0);
    expect(result.diffStatsFailed).toBe(1);
    expect(result.diffStatsRange).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auto-exclusion (sync_excluded)
// ---------------------------------------------------------------------------

function makeFakeDiscoveryStore(): {
  store: {
    updateRepositorySyncExcluded: (id: number, excluded: boolean, reason: string | null) => Promise<void>;
  };
  calls: Array<{ id: number; excluded: boolean; reason: string | null }>;
} {
  const calls: Array<{ id: number; excluded: boolean; reason: string | null }> = [];
  return {
    store: {
      async updateRepositorySyncExcluded(id, excluded, reason) {
        calls.push({ id, excluded, reason });
      },
    },
    calls,
  };
}

describe('syncRepositoryCommits — auto-exclusion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('BB 404 on /commits: auto-trips sync_excluded with reason=repo-404 and rethrows', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });
    const fakeDiscovery = makeFakeDiscoveryStore();

    await expect(
      syncRepositoryCommits(
        {
          client: makeClient(fetchMock as unknown as typeof globalThis.fetch),
          store,
          // Cast: tests only exercise the one method this code path calls.
          discoveryStore: fakeDiscovery.store as unknown as Parameters<
            typeof syncRepositoryCommits
          >[0]['discoveryStore'],
        },
        makeRepo(1),
      ),
    ).rejects.toThrow();

    expect(fakeDiscovery.calls).toEqual([{ id: 1, excluded: true, reason: 'repo-404' }]);
    expect(state.markFailedCalls).toHaveLength(1);
  });

  it('delta walk exhausts BB without finding cursor: auto-trips history-rewritten and skips insert', async () => {
    // 3 commits returned, no `next` — iterator exhausts. Cursor 'sha-gone' isn't in the list.
    fetchMock.mockResolvedValueOnce(
      commitsPage([makeCommit('sha-new-1'), makeCommit('sha-new-2'), makeCommit('sha-new-3')]),
    );
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-gone')] });
    const fakeDiscovery = makeFakeDiscoveryStore();

    const result = await syncRepositoryCommits(
      {
        client: makeClient(fetchMock as unknown as typeof globalThis.fetch),
        store,
        discoveryStore: fakeDiscovery.store as unknown as Parameters<typeof syncRepositoryCommits>[0]['discoveryStore'],
      },
      makeRepo(1),
    );

    expect(result.autoExcluded).toBe('history-rewritten');
    expect(result.inserted).toBe(0);
    expect(fakeDiscovery.calls).toEqual([{ id: 1, excluded: true, reason: 'history-rewritten' }]);
    expect(state.markFailedCalls).toHaveLength(1);
    expect(state.markSuccessCalls).toEqual([]);
    // No commits should have been inserted under the rewritten history.
    expect(state.commits.size).toBe(0);
  });

  it('delta walk finds cursor normally: no auto-exclusion, commits insert as usual', async () => {
    fetchMock.mockResolvedValueOnce(commitsPage([makeCommit('sha-new'), makeCommit('sha-cursor')]));
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    const fakeDiscovery = makeFakeDiscoveryStore();

    const result = await syncRepositoryCommits(
      {
        client: makeClient(fetchMock as unknown as typeof globalThis.fetch),
        store,
        discoveryStore: fakeDiscovery.store as unknown as Parameters<typeof syncRepositoryCommits>[0]['discoveryStore'],
      },
      makeRepo(1),
    );

    expect(result.autoExcluded).toBeNull();
    expect(result.inserted).toBe(1);
    expect(fakeDiscovery.calls).toEqual([]);
  });

  it('empty delta response (no commits at all, cursor not found): does NOT auto-exclude', async () => {
    // batch.length === 0 — even though hitKnownSha is false, no commits
    // came back so we can't conclude history was rewritten (might just
    // be a transient empty page or branch reset to nothing). Don't trip.
    fetchMock.mockResolvedValueOnce(commitsPage([]));
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1, 'sha-cursor')] });
    const fakeDiscovery = makeFakeDiscoveryStore();

    const result = await syncRepositoryCommits(
      {
        client: makeClient(fetchMock as unknown as typeof globalThis.fetch),
        store,
        discoveryStore: fakeDiscovery.store as unknown as Parameters<typeof syncRepositoryCommits>[0]['discoveryStore'],
      },
      makeRepo(1),
    );

    expect(result.autoExcluded).toBeNull();
    expect(fakeDiscovery.calls).toEqual([]);
  });

  it('no discoveryStore wired: 404 still throws but no exclusion attempt', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));
    const { store } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    await expect(
      syncRepositoryCommits(
        { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
        makeRepo(1),
      ),
    ).rejects.toThrow();
  });
});
