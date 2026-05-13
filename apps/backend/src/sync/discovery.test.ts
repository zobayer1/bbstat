import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import {
  addTrackedRepository,
  bootstrapTrackedRepositories,
  loadSeedTrackedRepos,
  parseSeedRepoFile,
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
      // Mirror the Drizzle impl: idempotent on bitbucket_uuid. If a row with
      // the same uuid already exists, return it with inserted: false so the
      // caller can treat alias retries as already-tracked.
      for (const existing of state.repositories.values()) {
        if (existing.bitbucketUuid === input.bitbucketUuid) {
          return { row: existing, inserted: false };
        }
      }
      const id = state.nextRepoId++;
      const row: RepositoryRow = { id, ...input };
      state.repositories.set(input.fullName, row);
      state.syncStateRepoIds.add(id);
      return { row, inserted: true };
    },
    async updateRepositoryDiffStatsEnabled(repositoryId, enabled) {
      for (const row of state.repositories.values()) {
        if (row.id === repositoryId) {
          row.diffStatsEnabled = enabled;
          return;
        }
      }
    },
    async listTrackedRepositories() {
      return Array.from(state.repositories.values());
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

describe('parseSeedRepoFile', () => {
  it('returns empty array when repos list is empty', () => {
    expect(parseSeedRepoFile('repos: []')).toEqual([]);
  });

  it('parses workspace/slug strings and tolerates surrounding whitespace', () => {
    const text = `
repos:
  - "  tigerit/boing-server  "
  - tigerit/boing-relay
`;
    expect(parseSeedRepoFile(text)).toEqual([
      { workspace: 'tigerit', slug: 'boing-server', diffStatsEnabled: false },
      { workspace: 'tigerit', slug: 'boing-relay', diffStatsEnabled: false },
    ]);
  });

  it('parses the object form { name, diffStats } and mixes it with plain strings', () => {
    const text = `
repos:
  - tigerit/boing-server
  - { name: tigerit/boing-relay, diffStats: true }
  - name: tigerit/comm-adm
    diffStats: false
  - name: tigerit/no-explicit-flag
`;
    expect(parseSeedRepoFile(text)).toEqual([
      { workspace: 'tigerit', slug: 'boing-server', diffStatsEnabled: false },
      { workspace: 'tigerit', slug: 'boing-relay', diffStatsEnabled: true },
      { workspace: 'tigerit', slug: 'comm-adm', diffStatsEnabled: false },
      // diffStats omitted on the object form defaults to false.
      { workspace: 'tigerit', slug: 'no-explicit-flag', diffStatsEnabled: false },
    ]);
  });

  it('throws on malformed entries', () => {
    expect(() => parseSeedRepoFile('repos: ["tigerit"]')).toThrow(/must be "<workspace>\/<slug>"/);
    expect(() => parseSeedRepoFile('repos: ["tigerit/"]')).toThrow(/must be "<workspace>\/<slug>"/);
    expect(() => parseSeedRepoFile('repos: ["/repo"]')).toThrow(/must be "<workspace>\/<slug>"/);
    // Object form with a bad `name`.
    expect(() => parseSeedRepoFile('repos: [{ name: tigerit, diffStats: true }]')).toThrow(
      /must be "<workspace>\/<slug>"/,
    );
  });

  it('throws when the top-level shape is wrong', () => {
    expect(() => parseSeedRepoFile('not_repos: []')).toThrow(/malformed/);
    expect(() => parseSeedRepoFile('repos: [1, 2]')).toThrow(/malformed/);
    expect(() => parseSeedRepoFile('repos: not-a-list')).toThrow(/malformed/);
    // Object form missing the required `name` field.
    expect(() => parseSeedRepoFile('repos: [{ diffStats: true }]')).toThrow(/malformed/);
  });
});

describe('loadSeedTrackedRepos', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bbstat-seed-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing file when required=false (default path)', () => {
    expect(loadSeedTrackedRepos(join(dir, 'missing.yaml'), { required: false })).toEqual([]);
  });

  it('throws on a missing file when required=true (explicit path)', () => {
    expect(() => loadSeedTrackedRepos(join(dir, 'missing.yaml'), { required: true })).toThrow(/could not be read/);
  });

  it('reads and parses an existing seed file', () => {
    const path = join(dir, 'seeds.yaml');
    writeFileSync(path, 'repos:\n  - tigerit/boing-server\n');
    expect(loadSeedTrackedRepos(path, { required: false })).toEqual([
      { workspace: 'tigerit', slug: 'boing-server', diffStatsEnabled: false },
    ]);
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
      diffStatsEnabled: false,
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
      diffStatsEnabled: false,
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

  it('returns already-tracked when the canonical bitbucket_uuid already exists', async () => {
    // The canonical row is keyed at tigerit/boing-server in the store. An
    // input alias like tigerit/Boing-Server misses findRepositoryByFullName
    // (strict string compare), proceeds to fetch BB, which returns the
    // canonical entity with the same uuid {r1}. The store-level ON CONFLICT
    // recovers — no 23505 bubbles up.
    const { store, state } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'tigerit',
      project: 'BOING',
      slug: 'boing-server',
      fullName: 'tigerit/boing-server',
      diffStatsEnabled: false,
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uuid: '{r1}',
        slug: 'boing-server',
        full_name: 'tigerit/boing-server',
        workspace: { slug: 'tigerit' },
        project: { key: 'BOING' },
      }),
    );
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'tigerit', 'Boing-Server');

    expect(result).toEqual({ fullName: 'tigerit/boing-server', status: 'already-tracked' });
    // Still just one row — no duplicate inserted.
    expect(state.repositories.size).toBe(1);
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
      diffStatsEnabled: false,
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
      { workspace: 'tigerit', slug: 'a', diffStatsEnabled: false },
      { workspace: 'tigerit', slug: 'b', diffStatsEnabled: false },
      { workspace: 'tigerit', slug: 'c', diffStatsEnabled: false },
    ]);

    expect(result).toEqual({
      requested: 3,
      inserted: 1,
      alreadyTracked: 1,
      notFound: ['tigerit/c'],
      diffStatsToggled: 0,
      errors: [],
    });
    // 2 HTTP calls total — `b` was a cache hit and made none.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('empty seed list is a no-op', async () => {
    const { store } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, []);

    expect(result).toEqual({
      requested: 0,
      inserted: 0,
      alreadyTracked: 0,
      notFound: [],
      diffStatsToggled: 0,
      errors: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('captures per-seed errors without aborting the loop', async () => {
    // Seed order: a (BB 400 — non-retryable, throws), b (succeeds).
    const { store, state } = createFakeStore();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'bad' } }, 400)).mockResolvedValueOnce(
      jsonResponse({
        uuid: '{rb}',
        slug: 'b',
        full_name: 'tigerit/b',
        workspace: { slug: 'tigerit' },
      }),
    );
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'tigerit', slug: 'a', diffStatsEnabled: false },
      { workspace: 'tigerit', slug: 'b', diffStatsEnabled: false },
    ]);

    expect(result.requested).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.alreadyTracked).toBe(0);
    expect(result.notFound).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ fullName: 'tigerit/a' });
    expect(result.errors[0]?.error).toContain('400');
    // `b` still landed.
    expect(state.repositories.has('tigerit/b')).toBe(true);
  });

  it('flips diff_stats_enabled on already-tracked rows when the YAML value diverges', async () => {
    const { store } = createFakeStore();
    // Pre-existing row at diffStatsEnabled=false; YAML says true.
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'tigerit',
      project: 'BOING',
      slug: 'boing-server',
      fullName: 'tigerit/boing-server',
      diffStatsEnabled: false,
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'tigerit', slug: 'boing-server', diffStatsEnabled: true },
    ]);

    expect(result.diffStatsToggled).toBe(1);
    expect(result.alreadyTracked).toBe(1);
    const row = await store.findRepositoryByFullName('tigerit/boing-server');
    expect(row?.diffStatsEnabled).toBe(true);
    // Reconciliation must NOT make an HTTP call — the repo was already tracked.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not toggle diff_stats_enabled when the YAML value matches', async () => {
    const { store } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'tigerit',
      project: 'BOING',
      slug: 'boing-server',
      fullName: 'tigerit/boing-server',
      diffStatsEnabled: true,
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'tigerit', slug: 'boing-server', diffStatsEnabled: true },
    ]);

    expect(result.diffStatsToggled).toBe(0);
  });
});
