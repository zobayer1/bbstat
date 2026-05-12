import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { BitbucketClient } from '../src/bitbucket/client.js';
import type { AppConfig } from '../src/config.js';
import type { CommitInsertInput, CommitStore, SyncStateRow, SyncSuccessUpdate } from '../src/sync/commit-store.js';
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
  SYNC_MEMBERS_CRON: '*/10 * * * *',
  SYNC_REPOS_CRON: '*/5 * * * *',
  SYNC_COMMITS_CRON: '*/15 * * * *',
  COMMITS_BACKFILL_MAX_PAGES: 5,
  COMMITS_BACKFILL_SINCE: '',
  COMMIT_SYNC_CONCURRENCY: 3,
  COMMIT_SYNC_BUDGET_THRESHOLD: 20,
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
    insertCommits: fail,
    getSyncState: fail,
    markSyncRunning: fail,
    markSyncSuccess: fail,
    markSyncFailed: fail,
  };
}

interface FakeCommitStoreState {
  commits: Map<string, CommitInsertInput>;
  syncStateByRepo: Map<number, SyncStateRow>;
  successCalls: Array<{ repositoryId: number; update: SyncSuccessUpdate }>;
}

function createFakeCommitStore(): { store: CommitStore; state: FakeCommitStoreState } {
  const state: FakeCommitStoreState = {
    commits: new Map(),
    syncStateByRepo: new Map(),
    successCalls: [],
  };
  const store: CommitStore = {
    async resolveUserIdsByUuid() {
      return new Map(); // no users seeded — every commit lands as anonymous
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
      const id = state.nextRepoId++;
      const row: RepositoryRow = { id, ...input };
      state.repositories.set(input.fullName, row);
      state.syncStateRepoIds.add(id);
      return row;
    },
    async listTrackedRepositories() {
      return Array.from(state.repositories.values());
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
        seeds: () => [{ workspace: 'tigerit', slug: 'boing-server' }],
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
      const repo = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',
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
      const repo = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: 'BOING',
        slug: 'boing-server',
        fullName: 'tigerit/boing-server',
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
      const r1 = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r1}',
        workspace: 'tigerit',
        project: null,
        slug: 'a',
        fullName: 'tigerit/a',
      });
      const r2 = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: '{r2}',
        workspace: 'tigerit',
        project: null,
        slug: 'b',
        fullName: 'tigerit/b',
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
});
