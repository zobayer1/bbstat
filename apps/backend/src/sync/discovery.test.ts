import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import {
  addTrackedRepository,
  bootstrapTrackedRepositories,
  parseSeedTrackedRepos,
  syncWorkspaceMembers,
} from './discovery.js';
import type { DiscoveryStore, RepositoryInsertInput, RepositoryRow, UserUpsertInput } from './discovery-store.js';

// ---------------------------------------------------------------------------
// In-memory fake of DiscoveryStore — fast, deterministic, enough for the
// behaviors we care about in discovery.ts.
// ---------------------------------------------------------------------------

interface FakeStoreState {
  users: Map<string, UserUpsertInput>; // by bitbucketUuid
  repositories: Map<string, RepositoryRow>; // by fullName
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
  };

  return { store, state };
}

// Helper to mint a BitbucketClient with an injected fetch mock.
function makeClient(fetchFn: typeof globalThis.fetch) {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'alice@example.com',
    token: 'tok',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------

describe('parseSeedTrackedRepos', () => {
  it('returns empty array for empty/undefined input', () => {
    expect(parseSeedTrackedRepos('')).toEqual([]);
    expect(parseSeedTrackedRepos(undefined)).toEqual([]);
  });

  it('parses comma-separated workspace/slug pairs and tolerates whitespace', () => {
    expect(parseSeedTrackedRepos('  tigerit/boing-server, tigerit/boing-relay ')).toEqual([
      { workspace: 'tigerit', slug: 'boing-server' },
      { workspace: 'tigerit', slug: 'boing-relay' },
    ]);
  });

  it('throws on malformed entries', () => {
    expect(() => parseSeedTrackedRepos('tigerit')).toThrow(/must be "<workspace>\/<slug>"/);
    expect(() => parseSeedTrackedRepos('tigerit/')).toThrow(/must be "<workspace>\/<slug>"/);
    expect(() => parseSeedTrackedRepos('/repo')).toThrow(/must be "<workspace>\/<slug>"/);
  });
});

describe('syncWorkspaceMembers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('upserts every member returned across paginated responses', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 2,
          values: [
            { user: { uuid: '{u1}', display_name: 'Alice', nickname: 'alice' } },
            { user: { uuid: '{u2}', display_name: 'Bob' } },
          ],
          next: 'https://api.bitbucket.org/2.0/workspaces/tigerit/members?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 2,
          values: [{ user: { uuid: '{u3}', display_name: 'Carol', nickname: 'carol' } }],
        }),
      );
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncWorkspaceMembers(deps, 'tigerit');

    expect(result).toEqual({ total: 3, inserted: 3, updated: 0 });
    expect(state.users.size).toBe(3);
    expect(state.users.get('{u2}')).toEqual({
      bitbucketUuid: '{u2}',
      displayName: 'Bob',
      username: null,
    });
  });

  it('counts existing users as updates, not inserts', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pagelen: 1,
        values: [{ user: { uuid: '{u1}', display_name: 'Alice', nickname: 'alice' } }],
      }),
    );
    const { store } = createFakeStore();
    await store.upsertUser({ bitbucketUuid: '{u1}', displayName: 'Old Name', username: null });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncWorkspaceMembers(deps, 'tigerit');

    expect(result).toEqual({ total: 1, inserted: 0, updated: 1 });
  });

  it('requests field-filtered values and includes `next`', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pagelen: 100, values: [] }));
    const { store } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncWorkspaceMembers(deps, 'tigerit');

    const [url] = fetchMock.mock.calls[0]!;
    const fields = new URL(url as string).searchParams.get('fields')!.split(',');
    expect(fields).toEqual(
      expect.arrayContaining(['values.user.uuid', 'values.user.display_name', 'values.user.nickname', 'next']),
    );
  });
});

describe('addTrackedRepository', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('inserts a new repo + its sync_state row on first add', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uuid: '{r1}',
        slug: 'boing-server',
        full_name: 'tigerit/boing-server',
        workspace: { slug: 'tigerit' },
        project: { key: 'BOING' },
      }),
    );
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'tigerit', 'boing-server');

    expect(result).toEqual({ fullName: 'tigerit/boing-server', status: 'inserted' });
    expect(state.repositories.size).toBe(1);
    expect(state.syncStateRepoIds.size).toBe(1);
    const row = state.repositories.get('tigerit/boing-server')!;
    expect(row).toMatchObject({
      bitbucketUuid: '{r1}',
      workspace: 'tigerit',
      project: 'BOING',
      slug: 'boing-server',
      fullName: 'tigerit/boing-server',
    });
  });

  it('returns already-tracked without making any HTTP call when repo exists', async () => {
    const { store, state } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'tigerit',
      project: 'BOING',
      slug: 'boing-server',
      fullName: 'tigerit/boing-server',
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'tigerit', 'boing-server');

    expect(result).toEqual({ fullName: 'tigerit/boing-server', status: 'already-tracked' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.repositories.size).toBe(1);
  });

  it('returns not-found on a 404 from BitBucket', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'tigerit', 'does-not-exist');

    expect(result).toEqual({ fullName: 'tigerit/does-not-exist', status: 'not-found' });
    expect(state.repositories.size).toBe(0);
  });

  it('handles repos with no project key (project: null)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uuid: '{r2}',
        slug: 'orphan',
        full_name: 'tigerit/orphan',
        workspace: { slug: 'tigerit' },
      }),
    );
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await addTrackedRepository(deps, 'tigerit', 'orphan');

    expect(state.repositories.get('tigerit/orphan')!.project).toBeNull();
  });
});

describe('bootstrapTrackedRepositories', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('aggregates per-seed outcomes (inserted / already-tracked / not-found)', async () => {
    // Seed order: a (insert), b (already), c (404)
    const { store } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{rb}',
      workspace: 'tigerit',
      project: null,
      slug: 'b',
      fullName: 'tigerit/b',
    });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          uuid: '{ra}',
          slug: 'a',
          full_name: 'tigerit/a',
          workspace: { slug: 'tigerit' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));

    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'tigerit', slug: 'a' },
      { workspace: 'tigerit', slug: 'b' },
      { workspace: 'tigerit', slug: 'c' },
    ]);

    expect(result).toEqual({
      requested: 3,
      inserted: 1,
      alreadyTracked: 1,
      notFound: ['tigerit/c'],
    });
    // 2 HTTP calls total — `b` was a cache hit and made none.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('empty seed list is a no-op', async () => {
    const { store } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, []);

    expect(result).toEqual({ requested: 0, inserted: 0, alreadyTracked: 0, notFound: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
