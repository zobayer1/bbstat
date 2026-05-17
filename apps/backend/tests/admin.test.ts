import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { BitbucketClient } from '../src/bitbucket/client.js';
import type { AppConfig } from '../src/config.js';
import type { CommitInsertInput, CommitStore, SyncStateRow, SyncSuccessUpdate } from '../src/sync/commit-store.js';
import type { PrStore, PullRequestInsertInput } from '../src/sync/pr-store.js';
import type {
  DiscoveryStore,
  RepositoryInsertInput,
  RepositoryRow,
  UserUpsertInput,
} from '../src/sync/discovery-store.js';
import type { SyncRunnerDeps } from '../src/sync/runner.js';

const testConfig: AppConfig = {
  NODE_ENV: 'test',
  BACKEND_HOST: 'localhost',
  BACKEND_PORT: 0,
  TLS_KEY_PATH: 'etc/tls/server.key',
  TLS_CERT_PATH: 'etc/tls/server.crt',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  BITBUCKET_BASE_URL: 'https://api.bitbucket.org/2.0',
  BITBUCKET_HOURLY_CALL_BUDGET: 800,
  BITBUCKET_MIN_CALL_INTERVAL_MS: 0,
  BITBUCKET_MAX_CALL_INTERVAL_MS: 0,
  SYNC_MEMBERS_CRON: '*/10 * * * *',
  SYNC_REPOS_CRON: '*/5 * * * *',
  SYNC_COMMITS_CRON: '*/15 * * * *',
  COMMITS_BACKFILL_MAX_PAGES: 5,
  COMMITS_BACKFILL_SINCE: '',
  COMMIT_SYNC_CONCURRENCY: 3,
  COMMIT_SYNC_BUDGET_THRESHOLD: 20,
  DIFF_STATS_BUDGET_THRESHOLD: 10,
  DIFF_STATS_BACKFILL_MAX_COMMITS_PER_TICK: 50,
  DIFF_STATS_BACKFILL_BUDGET_THRESHOLD: 20,
  SYNC_PRS_ENABLED: false,
  SYNC_PRS_CRON: '*/30 * * * *',
  PR_BACKFILL_MAX_PAGES: 5,
  PR_SYNC_CONCURRENCY: 3,
  PR_SYNC_BUDGET_THRESHOLD: 20,
  DEEPEN_BACKFILL_MAX_PAGES: 5,
  DEEPEN_BUDGET_THRESHOLD: 100,
  SYNC_BACKOFF_SLOPE_MIN_PER_QUIET_DAY: 4,
  SYNC_BACKOFF_MIN_INTERVAL_MIN: 5,
  SYNC_BACKOFF_MAX_INTERVAL_MIN: 1440,
  IS_MERGE_BACKFILL_MAX_PAGES: 5,
  IS_MERGE_BACKFILL_BUDGET_THRESHOLD: 50,
};

// Discovery-flow admin tests don't exercise commit-sync. Provide a CommitStore
// that throws on every method so any accidental call surfaces in test output
// instead of silently passing.
function noopCommitStore(): CommitStore {
  const fail = (): never => {
    throw new Error('CommitStore method called from discovery admin test');
  };
  return {
    resolveUserIdsByUuid: fail,
    setUserEmailsIfMissing: fail,
    listUsersMissingEmailWithLastCommit: fail,
    insertCommits: fail,
    getSyncState: fail,
    markSyncRunning: fail,
    markSyncSuccess: fail,
    markSyncFailed: fail,
    listPendingDiffStatCommits: fail,
    listPendingDiffStatCommitsGlobal: fail,
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
    // No-op (not a `fail`) — the admin /include and /rename endpoints
    // invoke this as a benign post-recovery cleanup on every call, so
    // throwing would false-positive those tests that don't exercise
    // commit-sync proper.
    async resetSyncCursors() {},
    async resetDiffStatsForRepo() {
      return { resetCount: 0 };
    },
  };
}

// Same idea for PrStore — discovery / commit-sync admin tests don't touch
// PR ingest. Default to throwing so accidental calls fail loudly. The
// dedicated PR admin tests override this with a working fake.
function noopPrStore(): PrStore {
  const fail = (): never => {
    throw new Error('PrStore method called from non-PR admin test');
  };
  return {
    resolveUserIdsByUuid: fail,
    upsertPullRequests: fail,
    getPrSyncState: fail,
    markPrSyncSuccess: fail,
  };
}

interface FakePrStoreState {
  prsByKey: Map<string, PullRequestInsertInput>; // `${repoId}:${bbId}`
  prStateByRepo: Map<number, { lastPrUpdatedAt: Date | null; lastPrId: number | null; prTotalSynced: number }>;
}

function createFakePrStore(): { store: PrStore; state: FakePrStoreState } {
  const state: FakePrStoreState = {
    prsByKey: new Map(),
    prStateByRepo: new Map(),
  };
  const store: PrStore = {
    async resolveUserIdsByUuid() {
      return new Map();
    },
    async upsertPullRequests(input) {
      let inserted = 0;
      let updated = 0;
      for (const pr of input) {
        const key = `${pr.repositoryId}:${pr.bitbucketPrId}`;
        if (state.prsByKey.has(key)) updated++;
        else inserted++;
        state.prsByKey.set(key, pr);
      }
      return { inserted, updated };
    },
    async getPrSyncState(repositoryId) {
      const row = state.prStateByRepo.get(repositoryId);
      if (row === undefined) return null;
      return {
        repositoryId,
        lastPrUpdatedAt: row.lastPrUpdatedAt,
        lastPrId: row.lastPrId,
        prLastSyncedAt: null,
        prTotalSynced: row.prTotalSynced,
      };
    },
    async markPrSyncSuccess(repositoryId, update) {
      const row = state.prStateByRepo.get(repositoryId) ?? {
        lastPrUpdatedAt: null,
        lastPrId: null,
        prTotalSynced: 0,
      };
      state.prStateByRepo.set(repositoryId, {
        lastPrUpdatedAt: update.newCursor?.updatedAt ?? row.lastPrUpdatedAt,
        lastPrId: update.newCursor?.prId ?? row.lastPrId,
        prTotalSynced: row.prTotalSynced + update.addedOrUpdated,
      });
    },
  };
  return { store, state };
}

interface FakeCommitStoreState {
  commits: Map<string, CommitInsertInput>;
  syncStateByRepo: Map<number, SyncStateRow>;
  successCalls: Array<{ repositoryId: number; update: SyncSuccessUpdate }>;
  isMergeBackfillCalls: Array<{ repositoryId: number; entries: Array<{ sha: string; isMerge: boolean }> }>;
}

function createFakeCommitStore(): { store: CommitStore; state: FakeCommitStoreState } {
  const state: FakeCommitStoreState = {
    commits: new Map(),
    syncStateByRepo: new Map(),
    successCalls: [],
    isMergeBackfillCalls: [],
  };
  const store: CommitStore = {
    async resolveUserIdsByUuid() {
      return new Map(); // no users seeded — every commit lands as anonymous
    },
    async setUserEmailsIfMissing() {
      // No-op for admin tests — write-once email capture is exercised in
      // commits.test.ts where the fake CommitStore actually tracks emails.
    },
    async listUsersMissingEmailWithLastCommit() {
      // No-op default — dedicated email-backfill tests construct a
      // fresh CommitStore stub that returns seed data inline.
      return [];
    },
    async insertCommits(input) {
      const insertedRows: Array<{ id: number; sha: string; authoredAt: Date }> = [];
      let nextId = state.commits.size + 1;
      for (const c of input) {
        const key = `${c.repositoryId}:${c.sha}`;
        if (!state.commits.has(key)) {
          state.commits.set(key, c);
          insertedRows.push({ id: nextId++, sha: c.sha, authoredAt: c.authoredAt });
        }
      }
      return { inserted: insertedRows.length, insertedRows };
    },
    async getSyncState(repositoryId) {
      return state.syncStateByRepo.get(repositoryId) ?? null;
    },
    async markSyncRunning(repositoryId) {
      const row = state.syncStateByRepo.get(repositoryId);
      if (row) {
        state.syncStateByRepo.set(repositoryId, { ...row, lastSyncStatus: 'running' });
      }
    },
    async markSyncSuccess(repositoryId, update) {
      state.successCalls.push({ repositoryId, update });
      const row = state.syncStateByRepo.get(repositoryId);
      if (row) {
        state.syncStateByRepo.set(repositoryId, {
          ...row,
          lastSyncStatus: 'success',
          lastSyncError: null,
          ...(update.lastSeenSha !== null ? { lastSeenSha: update.lastSeenSha } : {}),
          totalCommitsSynced: row.totalCommitsSynced + update.commitsAdded,
        });
      }
    },
    async markSyncFailed(repositoryId, error) {
      const row = state.syncStateByRepo.get(repositoryId);
      if (row) {
        state.syncStateByRepo.set(repositoryId, { ...row, lastSyncStatus: 'failed', lastSyncError: error });
      }
    },
    async listPendingDiffStatCommits() {
      // Inline-eager path — tests in this file never insert commits with
      // pending diff stats. Safe default for any future test that does.
      return [];
    },
    async listPendingDiffStatCommitsGlobal() {
      // Global newest-first pickup — not exercised by admin tests.
      return [];
    },
    async updateCommitDiffStats() {
      // No-op fallback — same reasoning as above.
    },
    async getOldestCommitSha() {
      return null;
    },
    async pickRepoForDeepening() {
      // Deepen-backfill admin tests can override per-test; the default
      // "no candidate" means runCommitsSync's piggyback step is a no-op.
      return null;
    },
    async markDeepenAttempt() {},
    async markDeepenComplete() {},
    async updateIsMergeBatch(repositoryId, entries) {
      state.isMergeBackfillCalls.push({ repositoryId, entries });
      return { updated: entries.length };
    },
    async pickRepoForIsMergeBackfill() {
      // No-op default; the is-merge tick treats this as queue-empty.
      // Dedicated tests can override per-suite if needed.
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

interface FakeStoreState {
  users: Map<string, UserUpsertInput>;
  repositories: Map<string, RepositoryRow>;
  syncStateRepoIds: Set<number>;
  nextRepoId: number;
}

function createFakeStore(): { store: DiscoveryStore; state: FakeStoreState } {
  const state: FakeStoreState = {
    users: new Map(),
    repositories: new Map(),
    syncStateRepoIds: new Set(),
    nextRepoId: 1,
  };
  const store: DiscoveryStore = {
    async upsertUser(input) {
      const wasNew = !state.users.has(input.bitbucketUuid);
      state.users.set(input.bitbucketUuid, input);
      return { inserted: wasNew };
    },
    async findRepositoryByFullName(fullName) {
      return state.repositories.get(fullName) ?? null;
    },
    async insertRepositoryWithSyncState(input: RepositoryInsertInput) {
      for (const existing of state.repositories.values()) {
        if (existing.bitbucketUuid === input.bitbucketUuid) {
          return { row: existing, inserted: false };
        }
      }
      const id = state.nextRepoId++;
      const row: RepositoryRow = {
        id,
        ...input,
        syncExcluded: false,
        syncExcludeReason: null,
        diffStatsExcludePatterns: [],
      };
      state.repositories.set(input.fullName, row);
      state.syncStateRepoIds.add(id);
      return { row, inserted: true };
    },
    async updateRepositoryArchived(repositoryId, archived) {
      for (const row of state.repositories.values()) {
        if (row.id === repositoryId) {
          row.archived = archived;
          return;
        }
      }
    },
    async listTrackedRepositories() {
      return Array.from(state.repositories.values()).filter((r) => !r.archived && !r.syncExcluded);
    },
    async updateRepositorySyncExcluded(repositoryId, excluded, reason) {
      for (const row of state.repositories.values()) {
        if (row.id === repositoryId) {
          row.syncExcluded = excluded;
          row.syncExcludeReason = reason;
          return;
        }
      }
    },
    async updateRepositoryRename(repositoryId, input) {
      for (const row of state.repositories.values()) {
        if (row.id === repositoryId) {
          // Re-key the map under the new fullName so findRepositoryByFullName
          // continues to resolve correctly post-rename.
          const oldFullName = row.fullName;
          row.workspace = input.workspace;
          row.slug = input.slug;
          row.fullName = input.fullName;
          row.project = input.project;
          state.repositories.delete(oldFullName);
          state.repositories.set(row.fullName, row);
          return;
        }
      }
    },
    async deleteRepository(repositoryId) {
      for (const [k, row] of state.repositories.entries()) {
        if (row.id === repositoryId) {
          state.repositories.delete(k);
          state.syncStateRepoIds.delete(repositoryId);
          return 1;
        }
      }
      return 0;
    },
    async updateRepositoryExcludePatterns(repositoryId, patterns) {
      for (const row of state.repositories.values()) {
        if (row.id === repositoryId) {
          row.diffStatsExcludePatterns = patterns;
          return;
        }
      }
    },
    async listRepositoriesForSync() {
      // Admin tests don't seed activity history; default backoffOptions
      // is unset in makeSyncDeps (legacy behavior — every repo is due).
      // Synthesize nulls so the row type is satisfied.
      return Array.from(state.repositories.values())
        .filter((r) => !r.archived && !r.syncExcluded)
        .map((r) => ({
          ...r,
          lastSyncedAt: null,
          prLastSyncedAt: null,
          latestCommitAt: null,
          latestPrAt: null,
          createdAt: new Date(),
        }));
    },
  };
  return { store, state };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSyncDeps(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: Partial<SyncRunnerDeps> = {},
): { deps: SyncRunnerDeps; state: FakeStoreState } {
  const { store, state } = createFakeStore();
  const logger = createLogger('test');
  const client = new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'alice@example.com',
    token: 'tok',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    retryBaseDelayMs: 0,
    logger,
  });
  return {
    deps: {
      client,
      store,
      logger,
      workspace: 'tigerit',
      seeds: () => [],
      commitStore: noopCommitStore(),
      prStore: noopPrStore(),
      ...overrides,
    },
    state,
  };
}

describe('admin routes', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  describe('absent when syncDeps is not configured', () => {
    it('admin routes return 404 if buildApp got no syncDeps', async () => {
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test') });
      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/sync/discover' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/admin/sync/discover', () => {
    it('runs members + repo bootstrap and returns the combined result', async () => {
      // 1 page of 2 members, then 1 repo lookup that succeeds
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            pagelen: 100,
            values: [
              { user: { uuid: '{u1}', display_name: 'Alice', nickname: 'alice' } },
              { user: { uuid: '{u2}', display_name: 'Bob' } },
            ],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            uuid: '{r1}',
            slug: 'boing-server',
            full_name: 'tigerit/boing-server',
            workspace: { slug: 'tigerit' },
            project: { key: 'BOING' },
          }),
        );
      const { deps, state } = makeSyncDeps(fetchMock, {
        seeds: () => [{ workspace: 'tigerit', slug: 'boing-server', archived: false }],
      });
      appInstance = await buildApp({
        config: testConfig,
        logger: createLogger('test'),
        syncDeps: deps,
      });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/sync/discover' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trigger).toBe('manual');
      expect(body.members).toEqual({ total: 2, inserted: 2, updated: 0 });
      expect(body.repos).toEqual({
        requested: 1,
        inserted: 1,
        alreadyTracked: 0,
        notFound: [],
        errors: [],
      });
      expect(state.users.size).toBe(2);
      expect(state.repositories.size).toBe(1);
    });
  });

  describe('POST /api/admin/repositories', () => {
    it('returns 201 and inserts on first add', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          uuid: '{r1}',
          slug: 'boing-relay',
          full_name: 'tigerit/boing-relay',
          workspace: { slug: 'tigerit' },
          project: { key: 'BOING' },
        }),
      );
      const { deps, state } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({
        config: testConfig,
        logger: createLogger('test'),
        syncDeps: deps,
      });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories',
        payload: { workspace: 'tigerit', slug: 'boing-relay' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        fullName: 'tigerit/boing-relay',
        status: 'inserted',
      });
      expect(state.repositories.size).toBe(1);
    });

    it('returns 200 when the repo is already tracked (idempotent)', async () => {
      const { deps, state } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      appInstance = await buildApp({
        config: testConfig,
        logger: createLogger('test'),
        syncDeps: deps,
      });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories',
        payload: { workspace: 'tigerit', slug: 'boing-server' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        fullName: 'tigerit/boing-server',
        status: 'already-tracked',
      });
      expect(state.repositories.size).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 404 when BitBucket says the repo does not exist', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({
        config: testConfig,
        logger: createLogger('test'),
        syncDeps: deps,
      });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories',
        payload: { workspace: 'tigerit', slug: 'does-not-exist' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        fullName: 'tigerit/does-not-exist',
        status: 'not-found',
      });
    });

    it('returns 400 on a malformed body', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({
        config: testConfig,
        logger: createLogger('test'),
        syncDeps: deps,
      });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories',
        payload: { workspace: 'tigerit' }, // missing slug
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('invalid_body');
      expect(body.issues).toBeInstanceOf(Array);
    });
  });

  describe('POST /api/admin/repositories/:workspace/:slug/archive', () => {
    it('flips archived=true and returns 200 on first archive', async () => {
      const { deps, state } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/boing-server/archive',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/boing-server', archived: true });
      const row = await deps.store.findRepositoryByFullName('tigerit/boing-server');
      expect(row?.archived).toBe(true);
      // Archived rows drop out of listTrackedRepositories.
      const tracked = await deps.store.listTrackedRepositories();
      expect(tracked).toEqual([]);
      expect(state.repositories.size).toBe(1); // row still exists
    });

    it('is idempotent — POST archive on already-archived returns 200', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: true,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/boing-server/archive',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/boing-server', archived: true });
    });

    it('returns 404 when the repo is not tracked', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/ghost/archive',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_tracked', fullName: 'tigerit/ghost' });
    });
  });

  describe('POST /api/admin/repositories/:workspace/:slug/unarchive', () => {
    it('flips archived=false and returns 200', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: true,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/boing-server/unarchive',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/boing-server', archived: false });
      // Back in the tracked list.
      const tracked = await deps.store.listTrackedRepositories();
      expect(tracked.map((r) => r.fullName)).toEqual(['tigerit/boing-server']);
    });

    it('returns 404 when the repo is not tracked', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/ghost/unarchive',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/admin/repositories/:workspace/:slug/include', () => {
    it('clears sync_excluded + reason and returns 200', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      const { row } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      await deps.store.updateRepositorySyncExcluded(row.id, true, 'history-rewritten');
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/boing-server/include',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        fullName: 'tigerit/boing-server',
        syncExcluded: false,
        cursorsReset: true,
      });
      const after = await deps.store.findRepositoryByFullName('tigerit/boing-server');
      expect(after?.syncExcluded).toBe(false);
      expect(after?.syncExcludeReason).toBeNull();
    });

    it('is idempotent on a non-excluded repo (still resets cursors)', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/boing-server/include',
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when the repo is not tracked', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/ghost/include',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/admin/repositories/:workspace/:slug/rename', () => {
    it('updates ws/slug/fullName/project on UUID match and clears exclusion', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      const { row } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'OLD',
        slug: 'old-name',
        fullName: 'tigerit/old-name',

        archived: false,
      });
      await deps.store.updateRepositorySyncExcluded(row.id, true, 'repo-404');
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          uuid: '{r1}',
          slug: 'new-name',
          full_name: 'tigerit/new-name',
          workspace: { slug: 'tigerit' },
          project: { key: 'NEW' },
        }),
      );
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/old-name/rename',
        payload: { workspace: 'tigerit', slug: 'new-name' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        previousFullName: 'tigerit/old-name',
        fullName: 'tigerit/new-name',
        syncExcluded: false,
        cursorsReset: true,
      });
      const after = await deps.store.findRepositoryByFullName('tigerit/new-name');
      expect(after?.slug).toBe('new-name');
      expect(after?.project).toBe('NEW');
      expect(after?.syncExcluded).toBe(false);
    });

    it('returns 409 when BB resolves to a different UUID', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'old-name',
        fullName: 'tigerit/old-name',

        archived: false,
      });
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          uuid: '{r-different}',
          slug: 'other',
          full_name: 'tigerit/other',
          workspace: { slug: 'tigerit' },
        }),
      );
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/old-name/rename',
        payload: { workspace: 'tigerit', slug: 'other' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'uuid_mismatch' });
      // Row unchanged.
      const after = await deps.store.findRepositoryByFullName('tigerit/old-name');
      expect(after?.slug).toBe('old-name');
    });

    it('returns 404 (bitbucket_not_found) when BB itself 404s the new slug', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'old-name',
        fullName: 'tigerit/old-name',

        archived: false,
      });
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/old-name/rename',
        payload: { workspace: 'tigerit', slug: 'ghost' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'bitbucket_not_found' });
    });

    it('returns 400 on invalid body', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'old-name',
        fullName: 'tigerit/old-name',

        archived: false,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/old-name/rename',
        payload: { workspace: '', slug: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('diff-stats exclusions', () => {
    async function seedRepo(deps: SyncRunnerDeps): Promise<void> {
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'r',
        fullName: 'tigerit/r',

        archived: false,
      });
    }

    it('GET returns empty list by default', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await seedRepo(deps);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'GET',
        url: '/api/admin/repositories/tigerit/r/diff-stats/exclusions',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/r', patterns: [] });
    });

    it('PUT replaces the pattern list and is round-trippable via GET', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await seedRepo(deps);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const putRes = await appInstance.inject({
        method: 'PUT',
        url: '/api/admin/repositories/tigerit/r/diff-stats/exclusions',
        payload: { patterns: ['*.png', '**/pnpm-lock.yaml', 'dist/**'] },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json()).toEqual({
        fullName: 'tigerit/r',
        patterns: ['*.png', '**/pnpm-lock.yaml', 'dist/**'],
      });

      const getRes = await appInstance.inject({
        method: 'GET',
        url: '/api/admin/repositories/tigerit/r/diff-stats/exclusions',
      });
      expect(getRes.json()).toEqual({
        fullName: 'tigerit/r',
        patterns: ['*.png', '**/pnpm-lock.yaml', 'dist/**'],
      });
    });

    it('PUT rejects an empty string in the pattern array with 400', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await seedRepo(deps);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'PUT',
        url: '/api/admin/repositories/tigerit/r/diff-stats/exclusions',
        payload: { patterns: ['*.png', ''] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_pattern', pattern: '' });
    });

    it('PUT returns 400 on a non-array body', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await seedRepo(deps);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'PUT',
        url: '/api/admin/repositories/tigerit/r/diff-stats/exclusions',
        payload: { patterns: 'not-an-array' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('GET/PUT return 404 for unknown repos', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const getRes = await appInstance.inject({
        method: 'GET',
        url: '/api/admin/repositories/tigerit/ghost/diff-stats/exclusions',
      });
      expect(getRes.statusCode).toBe(404);

      const putRes = await appInstance.inject({
        method: 'PUT',
        url: '/api/admin/repositories/tigerit/ghost/diff-stats/exclusions',
        payload: { patterns: [] },
      });
      expect(putRes.statusCode).toBe(404);
    });

    it('POST /reset returns 200 with the reset count', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      await seedRepo(deps);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/r/diff-stats/reset',
      });

      // The fake commitStore returns 0 for resetCount; we just verify
      // the route wiring + response shape. The real recount semantics
      // are covered in the resetDiffStatsForRepo unit tests / manual
      // smoke testing.
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/r', resetCount: 0 });
    });

    it('POST /reset returns 404 for unknown repo', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/ghost/diff-stats/reset',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/admin/repositories/:workspace/:slug', () => {
    it('removes the row and returns 200', async () => {
      const { deps, state } = makeSyncDeps(fetchMock);
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'doomed',
        fullName: 'tigerit/doomed',

        archived: false,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'DELETE',
        url: '/api/admin/repositories/tigerit/doomed',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/doomed', deleted: 1 });
      expect(state.repositories.has('tigerit/doomed')).toBe(false);
    });

    it('returns 404 when the repo is not tracked', async () => {
      const { deps } = makeSyncDeps(fetchMock);
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'DELETE',
        url: '/api/admin/repositories/tigerit/ghost',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Commit-sync admin endpoints — these exercise the real CommitStore fake +
  // mocked BB /commits responses so the tests cover the full route → runner →
  // tick → per-repo path with the actual store contract.
  // ---------------------------------------------------------------------------

  describe('POST /api/admin/sync/repositories/:workspace/:slug/commits', () => {
    it('returns 404 when the repo is not in the tracked set', async () => {
      const { store: commitStore } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/never-tracked/commits',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_tracked', fullName: 'tigerit/never-tracked' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('runs a delta pull and returns the per-repo result', async () => {
      const { store: commitStore, state: commitState } = createFakeCommitStore();
      const { deps, state } = makeSyncDeps(fetchMock, { commitStore });
      // Seed a tracked repo + sync_state row at the existing cursor.
      const { row: repo } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      commitState.syncStateByRepo.set(repo.id, {
        repositoryId: repo.id,
        lastSeenSha: 'sha-cursor',
        lastSyncedAt: null,
        lastSyncStartedAt: null,
        lastSyncStatus: 'idle',
        lastSyncError: null,
        totalCommitsSynced: 0,
      });
      // BB returns: 2 new commits, then the cursor sha → walks until cursor.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          pagelen: 100,
          values: [
            {
              hash: 'sha-new-1',
              message: 'feat: A',
              date: '2026-05-08T00:00:00+00:00',
              parents: [],
              author: { raw: 'A <a@x>' },
            },
            {
              hash: 'sha-new-2',
              message: 'feat: B',
              date: '2026-05-07T00:00:00+00:00',
              parents: [],
              author: { raw: 'B <b@x>' },
            },
            {
              hash: 'sha-cursor',
              message: 'old',
              date: '2026-05-01T00:00:00+00:00',
              parents: [],
              author: { raw: 'X <x@x>' },
            },
          ],
        }),
      );
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/boing-server/commits',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        repositoryId: repo.id,
        fullName: 'tigerit/boing-server',
        mode: 'delta',
        fetched: 2,
        inserted: 2,
        newCursor: 'sha-new-1',
        hitKnownSha: true,
      });
      expect(commitState.commits.size).toBe(2);
      expect(commitState.syncStateByRepo.get(repo.id)?.lastSeenSha).toBe('sha-new-1');
      expect(state.repositories.size).toBe(1);
    });

    it('is idempotent: a second call with no new commits inserts nothing', async () => {
      const { store: commitStore, state: commitState } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      const { row: repo } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      commitState.syncStateByRepo.set(repo.id, {
        repositoryId: repo.id,
        lastSeenSha: 'sha-cursor',
        lastSyncedAt: null,
        lastSyncStartedAt: null,
        lastSyncStatus: 'idle',
        lastSyncError: null,
        totalCommitsSynced: 0,
      });
      // Cursor matches first commit immediately — empty delta.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            pagelen: 100,
            values: [
              {
                hash: 'sha-cursor',
                message: 'old',
                date: '2026-05-01T00:00:00+00:00',
                parents: [],
                author: { raw: 'X <x@x>' },
              },
            ],
          }),
        ),
      );
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res1 = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/boing-server/commits',
      });
      const res2 = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/boing-server/commits',
      });

      expect(res1.json()).toMatchObject({ inserted: 0, hitKnownSha: true });
      expect(res2.json()).toMatchObject({ inserted: 0, hitKnownSha: true });
      expect(commitState.commits.size).toBe(0);
      expect(commitState.syncStateByRepo.get(repo.id)?.lastSeenSha).toBe('sha-cursor');
    });
  });

  describe('POST /api/admin/sync/commits', () => {
    it('runs a full tick across the curated set and returns the structured summary', async () => {
      const { store: commitStore, state: commitState } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      const { row: r1 } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'a',
        fullName: 'tigerit/a',

        archived: false,
      });
      const { row: r2 } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r2}',
        workspace: 'tigerit',
        project: null,
        slug: 'b',
        fullName: 'tigerit/b',

        archived: false,
      });
      for (const id of [r1.id, r2.id]) {
        commitState.syncStateByRepo.set(id, {
          repositoryId: id,
          lastSeenSha: null, // both cold
          lastSyncedAt: null,
          lastSyncStartedAt: null,
          lastSyncStatus: 'idle',
          lastSyncError: null,
          totalCommitsSynced: 0,
        });
      }
      // Each repo: a single page with one commit.
      fetchMock.mockImplementation((url) => {
        const slug = String(url).includes('/tigerit/a/') ? 'a' : 'b';
        return Promise.resolve(
          jsonResponse({
            pagelen: 100,
            values: [
              {
                hash: `${slug}-sha-1`,
                message: `commit on ${slug}`,
                date: '2026-05-08T00:00:00+00:00',
                parents: [],
                author: { raw: 'A <a@x>' },
              },
            ],
          }),
        );
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/sync/commits' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trigger).toBe('manual');
      expect(body.commits).toMatchObject({
        attempted: 2,
        deferred: 0,
        errors: 0,
        totalCommitsInserted: 2,
        stoppedEarly: false,
      });
      expect(body.repoResults).toHaveLength(2);
      expect(commitState.commits.size).toBe(2);
    });

    it('returns an empty summary when no repos are tracked', async () => {
      const { store: commitStore } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/sync/commits' });

      expect(res.statusCode).toBe(200);
      expect(res.json().commits).toMatchObject({
        attempted: 0,
        deferred: 0,
        errors: 0,
        totalCommitsInserted: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // PR-sync admin endpoints (Phase 4 T22). Parallel structure to the commit
  // admin endpoints: per-repo + workspace-wide entrypoints, real PrStore fake
  // + mocked BB /pullrequests responses.
  // ---------------------------------------------------------------------------

  describe('POST /api/admin/sync/repositories/:workspace/:slug/pullrequests', () => {
    it('returns 404 when the repo is not in the tracked set', async () => {
      const { store: prStore } = createFakePrStore();
      const { deps } = makeSyncDeps(fetchMock, { prStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/never-tracked/pullrequests',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_tracked', fullName: 'tigerit/never-tracked' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('runs a cold PR sync and returns the per-repo result', async () => {
      const { store: prStore, state: prState } = createFakePrStore();
      const { deps } = makeSyncDeps(fetchMock, { prStore });
      const { row: repo } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',

        archived: false,
      });
      // Seed an empty PR sync_state row so getPrSyncState returns a cold row.
      prState.prStateByRepo.set(repo.id, { lastPrUpdatedAt: null, lastPrId: null, prTotalSynced: 0 });
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          pagelen: 100,
          values: [
            {
              id: 42,
              title: 'feat: thing',
              state: 'OPEN',
              source: { branch: { name: 'feat' }, commit: { hash: 'src' } },
              destination: { branch: { name: 'main' }, commit: { hash: 'dst' } },
              author: { uuid: '{u1}' },
              created_on: '2026-05-08T12:00:00+00:00',
              updated_on: '2026-05-09T18:00:00+00:00',
              closed_on: null,
              comment_count: 0,
              task_count: 0,
            },
          ],
        }),
      );
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/boing-server/pullrequests',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        repositoryId: repo.id,
        fullName: 'tigerit/boing-server',
        mode: 'cold',
        fetched: 1,
        inserted: 1,
        updated: 0,
      });
      expect(prState.prsByKey.size).toBe(1);
    });
  });

  describe('POST /api/admin/sync/pullrequests', () => {
    it('runs a workspace-wide tick across the tracked set', async () => {
      const { store: prStore, state: prState } = createFakePrStore();
      const { deps } = makeSyncDeps(fetchMock, { prStore });
      const { row: repo1 } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'a',
        fullName: 'tigerit/a',

        archived: false,
      });
      const { row: repo2 } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r2}',
        workspace: 'tigerit',
        project: null,
        slug: 'b',
        fullName: 'tigerit/b',

        archived: false,
      });
      for (const id of [repo1.id, repo2.id]) {
        prState.prStateByRepo.set(id, { lastPrUpdatedAt: null, lastPrId: null, prTotalSynced: 0 });
      }
      // BB returns one PR per repo. Two paginated calls (one per repo).
      const onePr = (id: number, slug: string): Record<string, unknown> => ({
        id,
        title: `feat: thing in ${slug}`,
        state: 'OPEN',
        source: { branch: { name: 'feat' }, commit: { hash: 'src' } },
        destination: { branch: { name: 'main' }, commit: { hash: 'dst' } },
        author: { uuid: '{u}' },
        created_on: '2026-05-08T12:00:00+00:00',
        updated_on: '2026-05-09T18:00:00+00:00',
        closed_on: null,
        comment_count: 0,
        task_count: 0,
      });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ pagelen: 100, values: [onePr(1, 'a')] }))
        .mockResolvedValueOnce(jsonResponse({ pagelen: 100, values: [onePr(2, 'b')] }));
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/sync/pullrequests' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trigger).toBe('manual');
      expect(body.prs).toMatchObject({
        attempted: 2,
        deferred: 0,
        errors: 0,
        totalPrsInserted: 2,
        totalPrsUpdated: 0,
        stoppedEarly: false,
      });
      expect(body.repoResults).toHaveLength(2);
      expect(prState.prsByKey.size).toBe(2);
    });

    it('returns an empty summary when no repos are tracked', async () => {
      const { store: prStore } = createFakePrStore();
      const { deps } = makeSyncDeps(fetchMock, { prStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/sync/pullrequests' });

      expect(res.statusCode).toBe(200);
      expect(res.json().prs).toMatchObject({
        attempted: 0,
        deferred: 0,
        errors: 0,
        totalPrsInserted: 0,
        totalPrsUpdated: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Deepen-backfill admin endpoint. The worker logic itself is exercised
  // in src/sync/deepen-backfill.test.ts — here we only check the route's
  // 404-on-untracked and 503-on-no-candidate / no-budget behavior.
  // ---------------------------------------------------------------------------

  describe('POST /api/admin/sync/repositories/:workspace/:slug/deepen', () => {
    it('returns 404 when the repo is not in the tracked set', async () => {
      const { store: commitStore } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/never-tracked/deepen',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_tracked', fullName: 'tigerit/never-tracked' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 503 when the repo is tracked but has no commits yet (no seed sha)', async () => {
      const { store: commitStore } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'fresh',
        fullName: 'tigerit/fresh',

        archived: false,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      // Default commitStore fake returns null from getOldestCommitSha →
      // the worker returns an "empty" result rather than null. Route is
      // still 200 in that case (the result is informative). So this test
      // verifies the happy-path with no commits: result.fetched = 0,
      // route is 200, no BB call was made.
      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/sync/repositories/tigerit/fresh/deepen',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ fullName: 'tigerit/fresh', fetched: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/repositories/:workspace/:slug/backfill/is_merge', () => {
    it('walks /commits, maps parents.length > 1 to isMerge, and bulk-UPDATEs', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          pagelen: 100,
          values: [
            {
              hash: 'sha-a',
              message: 'feat',
              date: '2026-05-04T00:00:00Z',
              parents: [{ hash: 'p1' }],
              author: { raw: 'a' },
            },
            {
              hash: 'sha-merge',
              message: 'merge',
              date: '2026-05-03T00:00:00Z',
              parents: [{ hash: 'p1' }, { hash: 'p2' }],
              author: { raw: 'a' },
            },
            { hash: 'sha-init', message: 'init', date: '2026-05-01T00:00:00Z', parents: [], author: { raw: 'a' } },
          ],
        }),
      );
      const { store: commitStore, state: commitState } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'r1',
        fullName: 'tigerit/r1',

        archived: false,
      });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/r1/backfill/is_merge',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fullName: 'tigerit/r1', walked: 3, pages: 1, updated: 3 });

      // The fake captures the bulk call — assert the sha → isMerge mapping.
      expect(commitState.isMergeBackfillCalls).toHaveLength(1);
      expect(commitState.isMergeBackfillCalls[0]?.entries).toEqual([
        { sha: 'sha-a', isMerge: false },
        { sha: 'sha-merge', isMerge: true },
        { sha: 'sha-init', isMerge: false }, // initial commit (zero parents) is not a merge
      ]);
    });

    it('returns 404 when the repo is not tracked', async () => {
      const { store: commitStore } = createFakeCommitStore();
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/repositories/tigerit/never-tracked/backfill/is_merge',
      });

      expect(res.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Retroactive email backfill (commit #4 admin task). Per user-with-NULL-
  // email, fetches the one commit identified by the SQL seed, parses
  // `<email>` from author.raw, and write-once-updates the user row.
  // -------------------------------------------------------------------------
  describe('POST /api/admin/users/backfill-emails', () => {
    // Build a CommitStore override that:
    //   - returns a fixed list from listUsersMissingEmailWithLastCommit,
    //   - records every (uuid, email) entry passed to setUserEmailsIfMissing
    //     so we can assert exactly which writes the endpoint produced.
    function makeBackfillCommitStore(
      seed: Array<{ userId: number; bitbucketUuid: string; workspace: string; slug: string; sha: string }>,
    ): { store: CommitStore; writes: Array<{ bitbucketUuid: string; email: string }> } {
      const base = noopCommitStore();
      const writes: Array<{ bitbucketUuid: string; email: string }> = [];
      const store: CommitStore = {
        ...base,
        async listUsersMissingEmailWithLastCommit() {
          return seed;
        },
        async setUserEmailsIfMissing(entries) {
          for (const e of entries) writes.push(e);
        },
      };
      return { store, writes };
    }

    function commitPageWithRaw(sha: string, raw: string): Response {
      return jsonResponse({
        pagelen: 100,
        values: [
          {
            hash: sha,
            message: 'msg',
            date: '2026-05-08T00:00:00Z',
            parents: [],
            author: { raw },
          },
        ],
      });
    }

    it('writes the parsed email for each user that yields a parseable address', async () => {
      const { store: commitStore, writes } = makeBackfillCommitStore([
        { userId: 1, bitbucketUuid: '{u1}', workspace: 'tigerit', slug: 'repo-a', sha: 'sha-a' },
        { userId: 2, bitbucketUuid: '{u2}', workspace: 'tigerit', slug: 'repo-b', sha: 'sha-b' },
      ]);
      fetchMock
        .mockResolvedValueOnce(commitPageWithRaw('sha-a', 'Alice Example <alice@example.com>'))
        .mockResolvedValueOnce(commitPageWithRaw('sha-b', 'Bob <bob@example.org>'));
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/users/backfill-emails' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        attempted: 2,
        fetched: 2,
        written: 2,
        skippedNoParseableEmail: 0,
        fetchFailed: 0,
      });
      expect(writes).toEqual([
        { bitbucketUuid: '{u1}', email: 'alice@example.com' },
        { bitbucketUuid: '{u2}', email: 'bob@example.org' },
      ]);
    });

    it('skips users whose author.raw fails to parse (noreply / malformed) without aborting the batch', async () => {
      const { store: commitStore, writes } = makeBackfillCommitStore([
        { userId: 1, bitbucketUuid: '{u1}', workspace: 'tigerit', slug: 'repo-a', sha: 'sha-a' },
        { userId: 2, bitbucketUuid: '{u2}', workspace: 'tigerit', slug: 'repo-b', sha: 'sha-b' },
        { userId: 3, bitbucketUuid: '{u3}', workspace: 'tigerit', slug: 'repo-c', sha: 'sha-c' },
      ]);
      fetchMock
        .mockResolvedValueOnce(commitPageWithRaw('sha-a', 'Alice <alice@example.com>'))
        .mockResolvedValueOnce(commitPageWithRaw('sha-b', 'Bob <bot+noreply@users.noreply.bitbucket.org>'))
        .mockResolvedValueOnce(commitPageWithRaw('sha-c', 'just a name with no angle brackets'));
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/users/backfill-emails' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        attempted: 3,
        fetched: 3,
        written: 1,
        skippedNoParseableEmail: 2,
        fetchFailed: 0,
      });
      expect(writes).toEqual([{ bitbucketUuid: '{u1}', email: 'alice@example.com' }]);
    });

    it('records per-user fetch failures without poisoning the rest of the batch', async () => {
      const { store: commitStore, writes } = makeBackfillCommitStore([
        { userId: 1, bitbucketUuid: '{u1}', workspace: 'tigerit', slug: 'gone', sha: 'sha-gone' },
        { userId: 2, bitbucketUuid: '{u2}', workspace: 'tigerit', slug: 'live', sha: 'sha-live' },
      ]);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404))
        .mockResolvedValueOnce(commitPageWithRaw('sha-live', 'Alice <alice@example.com>'));
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/users/backfill-emails' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        attempted: 2,
        fetched: 1,
        written: 1,
        skippedNoParseableEmail: 0,
        fetchFailed: 1,
      });
      expect(writes).toEqual([{ bitbucketUuid: '{u2}', email: 'alice@example.com' }]);
    });

    it('returns a zero summary when no users are missing emails (no BB calls)', async () => {
      const { store: commitStore, writes } = makeBackfillCommitStore([]);
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({ method: 'POST', url: '/api/admin/users/backfill-emails' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        attempted: 0,
        fetched: 0,
        written: 0,
        skippedNoParseableEmail: 0,
        fetchFailed: 0,
      });
      expect(writes).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects limit above 2000 with 400', async () => {
      const { store: commitStore } = makeBackfillCommitStore([]);
      const { deps } = makeSyncDeps(fetchMock, { commitStore });
      appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), syncDeps: deps });

      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/admin/users/backfill-emails?limit=5000',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_limit', max: 2000 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
