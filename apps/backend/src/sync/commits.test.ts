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
  // UUIDs the auto-create path freshly inserted on this run. Tests
  // assert presence to confirm the ex-employee / never-member flow
  // fired without also asserting against the broader usersByUuid map.
  autoCreatedUuids: Set<string>;
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
    autoCreatedUuids: new Set(),
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
    async backfillAuthorSnapshotsFromUsers() {
      // Not exercised by per-repo commit-sync tests — covered by the
      // admin endpoint test in tests/admin.test.ts.
      return { updated: 0 };
    },
    async upsertAuthorUsers(inputs) {
      // Mirrors the Drizzle impl: INSERT (with is_workspace_member=false
      // + email) if the UUID is new; leave the existing row untouched
      // if it's already there. Returns uuid → id for every input.
      const map = new Map<string, number>();
      for (const e of inputs) {
        let id = state.usersByUuid.get(e.bitbucketUuid);
        if (id === undefined) {
          id = ++state.idSeq;
          state.usersByUuid.set(e.bitbucketUuid, id);
          // Record the email at INSERT time — the auto-create path
          // sets it directly, so it's no longer NULL.
          state.emailsByUuid.set(e.bitbucketUuid, e.email);
          state.autoCreatedUuids.add(e.bitbucketUuid);
        }
        map.set(e.bitbucketUuid, id);
      }
      return map;
    },
    async listUsersMissingEmailWithLastCommit() {
      // Not exercised by these per-repo sync tests — the admin email
      // backfill endpoint is the only caller, and its tests live in
      // tests/admin.test.ts.
      return [];
    },
    async listAnonymousCommits() {
      // Per-user retroactive reattribution is admin-driven; not
      // exercised by these per-repo sync tests.
      return [];
    },
    async reattributeAnonymousCommits() {
      // Same as above — the admin endpoint is the only caller.
      return [];
    },
    async incrementDiffStatsFailure() {
      // Not exercised by commit-sync tests — the diff-stats orchestrator
      // is the only caller, covered in diff-stats-tick.test.ts.
      return 0;
    },
    async insertCommits(input) {
      // Mirrors the Drizzle impl's ON CONFLICT DO UPDATE … WHERE
      // commits.author_user_id IS NULL AND EXCLUDED.author_user_id IS NOT NULL
      // semantics. Brand-new shas land in `insertedRows`; existing shas
      // whose stored author_user_id is NULL get their author backfilled
      // when the incoming row carries a known author and land in
      // `reattributedRows`. Everything else is a no-op (commit content
      // is immutable, and we never overwrite an established attribution).
      const insertedRows: Array<{ id: number; sha: string; authoredAt: Date }> = [];
      const reattributedRows: Array<{ id: number; sha: string; authoredAt: Date }> = [];
      for (const c of input) {
        const key = `${c.repositoryId}:${c.sha}`;
        const existing = state.commits.get(key);
        if (existing === undefined) {
          state.commits.set(key, c);
          const id = ++state.idSeq;
          state.idBySha.set(key, id);
          insertedRows.push({ id, sha: c.sha, authoredAt: c.authoredAt });
        } else if (existing.authorUserId === null && c.authorUserId !== null) {
          state.commits.set(key, { ...existing, authorUserId: c.authorUserId });
          const id = state.idBySha.get(key)!;
          reattributedRows.push({ id, sha: c.sha, authoredAt: existing.authoredAt });
        }
      }
      return { inserted: insertedRows.length, insertedRows, reattributedRows };
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

  it('resolves authors: matched user, AUTO-CREATED for unmatched UUID with email, anonymous (no user)', async () => {
    // Three commit shapes covering the full forward-sync author flow:
    //   * sha-known: BB UUID is already in our users table → resolves
    //     directly to the existing user id (id=42 for {u1}).
    //   * sha-unknown: BB UUID NOT in users table, but author.raw
    //     carries a parseable email → auto-create path fires. The
    //     fake store mints a new id and tracks the UUID in
    //     state.autoCreatedUuids so we can assert the path ran.
    //   * sha-anon: BB returned no author.user at all → stays
    //     anonymous regardless of what author.raw looks like.
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
    // Unknown UUID + parseable email → auto-created with a fresh id.
    // The exact id depends on the fake's idSeq; just check it's set
    // and the UUID landed in autoCreatedUuids.
    const unknownAuthor = state.commits.get('1:sha-unknown')?.authorUserId;
    expect(unknownAuthor).not.toBeNull();
    expect(unknownAuthor).not.toBe(42);
    expect(state.autoCreatedUuids.has('{u-missing}')).toBe(true);
    // No author.user from BB → stays anonymous, even though author.raw
    // has a parseable email. This is the "BB didn't resolve the
    // author to any account" case; without a UUID we have nothing to
    // upsert against (users.bitbucket_uuid is the unique key).
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

// ---------------------------------------------------------------------------
// Auto-create user rows for unknown UUIDs (ex-employees, externals)
//
// The scenario this guards: a commit lands whose BB author.user.uuid
// isn't currently in `/workspaces/{ws}/members` — typically because
// the contributor left the workspace, never joined, or is an external
// pusher. Pre-fix this dropped to author_user_id = NULL forever; the
// auto-create path now mints a `users` row with is_workspace_member=false
// and the commit attributes to it. Snapshot columns (author_email,
// author_display_name) land regardless of attribution outcome.
// ---------------------------------------------------------------------------

describe('syncRepositoryCommits — auto-create out-of-workspace users', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('auto-creates a user when BB UUID is unknown and author.raw has a parseable email', async () => {
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-ex-employee', {
          user: { uuid: '{u-ex-employee}', display_name: 'Ex Employee' },
        }),
      ]),
    );
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    // The unknown UUID got minted into the users map and the commit
    // attributes to the new id (not null).
    expect(state.autoCreatedUuids.has('{u-ex-employee}')).toBe(true);
    const newId = state.usersByUuid.get('{u-ex-employee}');
    expect(newId).toBeDefined();
    expect(state.commits.get('1:sha-ex-employee')?.authorUserId).toBe(newId);
    // Email was set at INSERT time on the auto-create path (parsed
    // from author.raw "Author <author@example.com>" — the fixture's
    // default).
    expect(state.emailsByUuid.get('{u-ex-employee}')).toBe('author@example.com');
  });

  it('email gate: BB UUID without parseable email stays anonymous (no auto-create)', async () => {
    // Author.raw is a noreply-filtered address — parseAuthorEmail
    // returns null, so the auto-create path is skipped per the
    // operator policy ("no auto-create without a real email").
    const commits = [
      {
        hash: 'sha-noreply-author',
        message: 'web merge from BB UI',
        date: '2026-05-01T00:00:00+00:00',
        parents: [],
        author: {
          raw: 'BB User <noreply@bitbucket.org>',
          user: { uuid: '{u-noreply}', display_name: 'BB User' },
        },
      },
    ];
    fetchMock.mockResolvedValueOnce(commitsPage(commits));
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(state.autoCreatedUuids.has('{u-noreply}')).toBe(false);
    expect(state.usersByUuid.has('{u-noreply}')).toBe(false);
    expect(state.commits.get('1:sha-noreply-author')?.authorUserId).toBeNull();
    // Snapshot columns: author_email stays null (parser filtered it
    // out), but author_display_name is populated from author.user.display_name.
    expect(state.commits.get('1:sha-noreply-author')?.authorEmail).toBeNull();
    expect(state.commits.get('1:sha-noreply-author')?.authorDisplayName).toBe('BB User');
  });

  it('no overwrite: existing users (member-sync-discovered) are not touched by the auto-create path', async () => {
    // {u1} is already in users (a current workspace member, id=42).
    // The auto-create path should NOT fire for this UUID — established
    // attribution paths through the normal resolveUserIdsByUuid match.
    fetchMock.mockResolvedValueOnce(
      commitsPage([makeCommit('sha-member', { user: { uuid: '{u1}', display_name: 'Alice' } })]),
    );
    const { store, state } = createFakeCommitStore({
      syncState: [makeSyncStateRow(1)],
      users: [['{u1}', 42]],
    });

    await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    // {u1} maps to existing id 42 (was seeded). The fake's
    // autoCreatedUuids only tracks UUIDs minted by upsertAuthorUsers,
    // and that path was bypassed for the already-known UUID.
    expect(state.autoCreatedUuids.has('{u1}')).toBe(false);
    expect(state.commits.get('1:sha-member')?.authorUserId).toBe(42);
  });

  it('snapshot columns: author_email + author_display_name land on every commit when available', async () => {
    const commits = [
      // Standard case: BB carries everything.
      makeCommit('sha-full', { user: { uuid: '{u1}', display_name: 'Alice' } }),
      // No BB user but parseable raw — display_name parsed from raw, email parsed too.
      {
        hash: 'sha-external',
        message: 'external contribution',
        date: '2026-05-01T00:00:00+00:00',
        parents: [],
        author: { raw: 'External Contributor <external@elsewhere.com>' },
      },
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

    // BB-resolved author: snapshot columns reflect what BB sent.
    expect(state.commits.get('1:sha-full')?.authorEmail).toBe('author@example.com');
    expect(state.commits.get('1:sha-full')?.authorDisplayName).toBe('Alice');
    // No BB user: stays anonymous (no UUID to upsert against), but
    // snapshot columns are still populated from author.raw — leaves
    // the forensic hook for future re-processing.
    expect(state.commits.get('1:sha-external')?.authorUserId).toBeNull();
    expect(state.commits.get('1:sha-external')?.authorEmail).toBe('external@elsewhere.com');
    expect(state.commits.get('1:sha-external')?.authorDisplayName).toBe('External Contributor');
  });

  it('deduplicates auto-create calls when the same unknown UUID appears in multiple commits', async () => {
    // Three commits from the same unknown UUID — the auto-create
    // path should fire once for the UUID (not three times) and all
    // three commits should attribute to the same resulting id.
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-a', { user: { uuid: '{u-dup}', display_name: 'Dup' } }),
        makeCommit('sha-b', { user: { uuid: '{u-dup}', display_name: 'Dup' } }),
        makeCommit('sha-c', { user: { uuid: '{u-dup}', display_name: 'Dup' } }),
      ]),
    );
    const { store, state } = createFakeCommitStore({ syncState: [makeSyncStateRow(1)] });

    await syncRepositoryCommits(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(state.autoCreatedUuids.size).toBe(1);
    const dupId = state.usersByUuid.get('{u-dup}');
    expect(dupId).toBeDefined();
    expect(state.commits.get('1:sha-a')?.authorUserId).toBe(dupId);
    expect(state.commits.get('1:sha-b')?.authorUserId).toBe(dupId);
    expect(state.commits.get('1:sha-c')?.authorUserId).toBe(dupId);
  });
});

// ---------------------------------------------------------------------------
// Reattribution on re-sync (anonymous → workspace member)
//
// Scenario this guards against: a commit was originally pushed with an
// author email that wasn't yet linked to any workspace member's BB
// account, so BB returned `author.user = undefined` at first ingest and
// we stored `author_user_id = NULL`. The same email is later added to a
// workspace member's account. BB now resolves `author.user.uuid` for the
// SAME commit, and a subsequent cold-mode re-sync (kicked off by
// POST /repositories/:ws/:slug/include, which clears `last_seen_sha`)
// fetches that commit again. The fix: ON CONFLICT DO UPDATE narrowly
// fills `author_user_id` when transitioning NULL → known, and we surface
// the affected day window so the rollup recompute swaps the stale
// (day, repo, NULL) row for the new (day, repo, user) row.
// ---------------------------------------------------------------------------

describe('syncRepositoryCommits — reattribution on re-sync', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('fills author_user_id when a previously anonymous commit comes back with a known UUID', async () => {
    // First pass: BB does not yet associate the commit's email with a
    // workspace member — author.user is absent, so we land the row with
    // author_user_id = NULL.
    fetchMock.mockResolvedValueOnce(commitsPage([makeCommit('sha-anon', { date: '2026-05-18T10:28:18+00:00' })]));
    const { store, state } = createFakeCommitStore({
      syncState: [makeSyncStateRow(1)],
      users: [['{u-foysal}', 142]],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncRepositoryCommits(deps, makeRepo(1));
    expect(state.commits.get('1:sha-anon')?.authorUserId).toBeNull();

    // Second pass: simulate POST /include resetting the cursor to cold,
    // and BB now resolving the commit's author to a workspace member.
    const row = state.syncStateByRepo.get(1)!;
    state.syncStateByRepo.set(1, { ...row, lastSeenSha: null });
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-anon', {
          date: '2026-05-18T10:28:18+00:00',
          user: { uuid: '{u-foysal}', display_name: 'Foysal Ahamed' },
        }),
      ]),
    );

    const result = await syncRepositoryCommits(deps, makeRepo(1));

    expect(state.commits.get('1:sha-anon')?.authorUserId).toBe(142);
    // Re-attributed rows are not counted as "inserted" — the row already
    // existed. They're surfaced via reattributedRange so the rollup hook
    // can rebuild the affected day window.
    expect(result.inserted).toBe(0);
    expect(result.reattributedRange).toEqual({ sinceDay: '2026-05-18', untilDay: '2026-05-18' });
  });

  it('does NOT overwrite an established attribution if BB later returns a different UUID', async () => {
    // Original ingest: commit belongs to Alice (uuid {u-alice} → user id 42).
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-pinned', {
          date: '2026-05-18T10:00:00+00:00',
          user: { uuid: '{u-alice}', display_name: 'Alice' },
        }),
      ]),
    );
    const { store, state } = createFakeCommitStore({
      syncState: [makeSyncStateRow(1)],
      users: [
        ['{u-alice}', 42],
        ['{u-bob}', 99],
      ],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncRepositoryCommits(deps, makeRepo(1));
    expect(state.commits.get('1:sha-pinned')?.authorUserId).toBe(42);

    // Cold re-sync: BB returns the same sha but suddenly attributes it
    // to Bob. We MUST NOT overwrite Alice — established attribution is
    // immutable, only NULL → known transitions are allowed.
    const row = state.syncStateByRepo.get(1)!;
    state.syncStateByRepo.set(1, { ...row, lastSeenSha: null });
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-pinned', {
          date: '2026-05-18T10:00:00+00:00',
          user: { uuid: '{u-bob}', display_name: 'Bob' },
        }),
      ]),
    );

    const result = await syncRepositoryCommits(deps, makeRepo(1));

    expect(state.commits.get('1:sha-pinned')?.authorUserId).toBe(42); // unchanged
    expect(result.reattributedRange).toBeNull();
  });

  it('reattributedRange spans the min/max authored day across multiple reattributed rows', async () => {
    // Seed two anonymous commits on different days.
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-newer', { date: '2026-05-18T12:00:00+00:00' }),
        makeCommit('sha-older', { date: '2026-05-15T08:00:00+00:00' }),
      ]),
    );
    const { store, state } = createFakeCommitStore({
      syncState: [makeSyncStateRow(1)],
      users: [['{u-foysal}', 142]],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };
    await syncRepositoryCommits(deps, makeRepo(1));

    // Re-sync: both commits now resolve to the workspace member.
    const row = state.syncStateByRepo.get(1)!;
    state.syncStateByRepo.set(1, { ...row, lastSeenSha: null });
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-newer', {
          date: '2026-05-18T12:00:00+00:00',
          user: { uuid: '{u-foysal}', display_name: 'Foysal' },
        }),
        makeCommit('sha-older', {
          date: '2026-05-15T08:00:00+00:00',
          user: { uuid: '{u-foysal}', display_name: 'Foysal' },
        }),
      ]),
    );

    const result = await syncRepositoryCommits(deps, makeRepo(1));

    expect(result.reattributedRange).toEqual({ sinceDay: '2026-05-15', untilDay: '2026-05-18' });
  });

  it('inline-eager diff-stats does NOT fetch /diffstat for reattributed rows', async () => {
    // Seed an anonymous commit (no diff-stats opt-in on the first run so
    // it stays plain).
    fetchMock.mockResolvedValueOnce(commitsPage([makeCommit('sha-anon', { date: '2026-05-18T10:00:00+00:00' })]));
    const { store, state } = createFakeCommitStore({
      syncState: [makeSyncStateRow(1)],
      users: [['{u-foysal}', 142]],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };
    await syncRepositoryCommits(deps, makeRepo(1));

    // Cold re-sync WITH diffStats opt-in. The commit gets reattributed
    // but is NOT a new row — inline-eager should leave it alone and let
    // the backfill tick handle any pending diff-stats work.
    const row = state.syncStateByRepo.get(1)!;
    state.syncStateByRepo.set(1, { ...row, lastSeenSha: null });
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeCommit('sha-anon', {
          date: '2026-05-18T10:00:00+00:00',
          user: { uuid: '{u-foysal}', display_name: 'Foysal' },
        }),
      ]),
    );

    const result = await syncRepositoryCommits(deps, makeRepo(1), {
      diffStats: { budgetThreshold: 10 },
    });

    expect(result.inserted).toBe(0);
    expect(result.reattributedRange).not.toBeNull();
    expect(result.diffStatsUpdated).toBe(0);
    expect(state.diffStatsUpdates).toHaveLength(0);
    // Only the /commits page was fetched — no /diffstat call.
    expect(fetchMock).toHaveBeenCalledTimes(2); // first run + second run /commits
  });
});
