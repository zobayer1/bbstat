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
  members: Set<string>; // bitbucketUuids currently is_workspace_member = true
  repositories: Map<string, RepositoryRow>; // by fullName
  syncStateRepoIds: Set<number>;
  nextRepoId: number;
}

function createFakeStore(): { store: DiscoveryStore; state: FakeStoreState } {
  const state: FakeStoreState = {
    users: new Map(),
    members: new Set(),
    repositories: new Map(),
    syncStateRepoIds: new Set(),
    nextRepoId: 1,
  };

  const store: DiscoveryStore = {
    async upsertUser(input) {
      const wasNew = !state.users.has(input.bitbucketUuid);
      state.users.set(input.bitbucketUuid, input);
      // Mirror the real store: every member-sync upsert forces membership TRUE
      // (this is the rejoin-flip seam).
      state.members.add(input.bitbucketUuid);
      return { inserted: wasNew };
    },
    async markDepartedMembers(seenUuids) {
      if (seenUuids.length === 0) return 0;
      const seen = new Set(seenUuids);
      const toDemote = [...state.members].filter((uuid) => !seen.has(uuid));
      for (const uuid of toDemote) state.members.delete(uuid);
      return toDemote.length;
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
    async listEmptyExcludedRepos() {
      return Array.from(state.repositories.values()).filter(
        (r) => !r.archived && r.syncExcluded && r.syncExcludeReason === 'empty-on-bitbucket',
      );
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
          row.workspace = input.workspace;
          row.slug = input.slug;
          row.fullName = input.fullName;
          row.project = input.project;
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
      // Synthesize the activity timestamps to nulls; tests in this file
      // don't exercise the backoff path. The runner falls back to
      // createdAt as the activity floor.
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
  - "  acme/api-server  "
  - acme/relay-service
`;
    expect(parseSeedRepoFile(text)).toEqual([
      { workspace: 'acme', slug: 'api-server', archived: false },
      { workspace: 'acme', slug: 'relay-service', archived: false },
    ]);
  });

  it('parses the object form { name, diffStats, archived } and mixes it with plain strings', () => {
    const text = `
repos:
  - acme/api-server
  - { name: acme/relay-service, diffStats: true }
  - name: acme/admin-portal
    diffStats: false
    archived: true
  - name: acme/no-explicit-flag
`;
    expect(parseSeedRepoFile(text)).toEqual([
      { workspace: 'acme', slug: 'api-server', archived: false },
      { workspace: 'acme', slug: 'relay-service', archived: false },
      { workspace: 'acme', slug: 'admin-portal', archived: true },
      // Both flags omitted on the object form default to false.
      { workspace: 'acme', slug: 'no-explicit-flag', archived: false },
    ]);
  });

  it('throws on malformed entries', () => {
    expect(() => parseSeedRepoFile('repos: ["acme"]')).toThrow(/must be "<workspace>\/<slug>"/);
    expect(() => parseSeedRepoFile('repos: ["acme/"]')).toThrow(/must be "<workspace>\/<slug>"/);
    expect(() => parseSeedRepoFile('repos: ["/repo"]')).toThrow(/must be "<workspace>\/<slug>"/);
    // Object form with a bad `name`.
    expect(() => parseSeedRepoFile('repos: [{ name: acme, diffStats: true }]')).toThrow(
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
    writeFileSync(path, 'repos:\n  - acme/api-server\n');
    expect(loadSeedTrackedRepos(path, { required: false })).toEqual([
      { workspace: 'acme', slug: 'api-server', archived: false },
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
          next: 'https://api.bitbucket.org/2.0/workspaces/acme/members?page=2',
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

    const result = await syncWorkspaceMembers(deps, 'acme');

    expect(result).toEqual({ total: 3, inserted: 3, updated: 0, departed: 0 });
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

    const result = await syncWorkspaceMembers(deps, 'acme');

    expect(result).toEqual({ total: 1, inserted: 0, updated: 1, departed: 0 });
  });

  it('demotes members who fell out of the roster (departed) and keeps their row', async () => {
    // Prior roster had u1 + u2; this pull returns only u1 → u2 departed.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        pagelen: 100,
        values: [{ user: { uuid: '{u1}', display_name: 'Alice', nickname: 'alice' } }],
      }),
    );
    const { store, state } = createFakeStore();
    await store.upsertUser({ bitbucketUuid: '{u1}', displayName: 'Alice', username: 'alice' });
    await store.upsertUser({ bitbucketUuid: '{u2}', displayName: 'Bob', username: 'bob' });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncWorkspaceMembers(deps, 'acme');

    expect(result).toEqual({ total: 1, inserted: 0, updated: 1, departed: 1 });
    // Row is retained (history intact) — only the membership flag flips off.
    expect(state.users.has('{u2}')).toBe(true);
    expect(state.members.has('{u2}')).toBe(false);
    expect(state.members.has('{u1}')).toBe(true);
  });

  it('re-promotes a returning member (rejoin flips the flag back)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ pagelen: 100, values: [] })) // u1 departs
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 100,
          values: [{ user: { uuid: '{u1}', display_name: 'Alice', nickname: 'alice' } }],
        }),
      );
    const { store, state } = createFakeStore();
    await store.upsertUser({ bitbucketUuid: '{u1}', displayName: 'Alice', username: 'alice' });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    // Empty pull → guarded, no demotion (see the empty-roster guard test).
    await syncWorkspaceMembers(deps, 'acme');
    expect(state.members.has('{u1}')).toBe(true);

    // Manually depart u1 to set up the rejoin, then a non-empty pull returns them.
    await store.markDepartedMembers(['{other}']);
    expect(state.members.has('{u1}')).toBe(false);
    const rejoin = await syncWorkspaceMembers(deps, 'acme');

    expect(rejoin.departed).toBe(0);
    expect(state.members.has('{u1}')).toBe(true);
  });

  it('skips departure reconciliation on an empty roster pull (never mass-demotes)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pagelen: 100, values: [] }));
    const { store, state } = createFakeStore();
    await store.upsertUser({ bitbucketUuid: '{u1}', displayName: 'Alice', username: 'alice' });
    await store.upsertUser({ bitbucketUuid: '{u2}', displayName: 'Bob', username: 'bob' });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncWorkspaceMembers(deps, 'acme');

    expect(result).toEqual({ total: 0, inserted: 0, updated: 0, departed: 0 });
    // Both members survive — an empty pull is a failed fetch, not an exodus.
    expect(state.members.has('{u1}')).toBe(true);
    expect(state.members.has('{u2}')).toBe(true);
  });

  it('requests field-filtered values and includes `next`', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ pagelen: 100, values: [] }));
    const { store } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncWorkspaceMembers(deps, 'acme');

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
        slug: 'api-server',
        full_name: 'acme/api-server',
        workspace: { slug: 'acme' },
        project: { key: 'PLATFORM' },
      }),
    );
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'acme', 'api-server');

    expect(result).toEqual({ fullName: 'acme/api-server', status: 'inserted' });
    expect(state.repositories.size).toBe(1);
    expect(state.syncStateRepoIds.size).toBe(1);
    const row = state.repositories.get('acme/api-server')!;
    expect(row).toMatchObject({
      bitbucketUuid: '{r1}',
      workspace: 'acme',
      project: 'PLATFORM',
      slug: 'api-server',
      fullName: 'acme/api-server',
      archived: false,
    });
  });

  it('returns already-tracked without making any HTTP call when repo exists', async () => {
    const { store, state } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'acme',
      project: 'PLATFORM',
      slug: 'api-server',
      fullName: 'acme/api-server',
      archived: false,
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'acme', 'api-server');

    expect(result).toEqual({ fullName: 'acme/api-server', status: 'already-tracked' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.repositories.size).toBe(1);
  });

  it('returns not-found on a 404 from BitBucket', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'acme', 'does-not-exist');

    expect(result).toEqual({ fullName: 'acme/does-not-exist', status: 'not-found' });
    expect(state.repositories.size).toBe(0);
  });

  it('handles repos with no project key (project: null)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uuid: '{r2}',
        slug: 'orphan',
        full_name: 'acme/orphan',
        workspace: { slug: 'acme' },
      }),
    );
    const { store, state } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await addTrackedRepository(deps, 'acme', 'orphan');

    expect(state.repositories.get('acme/orphan')!.project).toBeNull();
  });

  it('returns already-tracked when the canonical bitbucket_uuid already exists', async () => {
    // The canonical row is keyed at acme/api-server in the store. An
    // input alias like acme/Api-Server misses findRepositoryByFullName
    // (strict string compare), proceeds to fetch BB, which returns the
    // canonical entity with the same uuid {r1}. The store-level ON CONFLICT
    // recovers — no 23505 bubbles up.
    const { store, state } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'acme',
      project: 'PLATFORM',
      slug: 'api-server',
      fullName: 'acme/api-server',
      archived: false,
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uuid: '{r1}',
        slug: 'api-server',
        full_name: 'acme/api-server',
        workspace: { slug: 'acme' },
        project: { key: 'PLATFORM' },
      }),
    );
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await addTrackedRepository(deps, 'acme', 'Api-Server');

    expect(result).toEqual({ fullName: 'acme/api-server', status: 'already-tracked' });
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
      workspace: 'acme',
      project: null,
      slug: 'b',
      fullName: 'acme/b',
      archived: false,
    });

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          uuid: '{ra}',
          slug: 'a',
          full_name: 'acme/a',
          workspace: { slug: 'acme' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Not found' } }, 404));

    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'acme', slug: 'a', archived: false },
      { workspace: 'acme', slug: 'b', archived: false },
      { workspace: 'acme', slug: 'c', archived: false },
    ]);

    expect(result).toEqual({
      requested: 3,
      inserted: 1,
      alreadyTracked: 1,
      notFound: ['acme/c'],
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
        full_name: 'acme/b',
        workspace: { slug: 'acme' },
      }),
    );
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'acme', slug: 'a', archived: false },
      { workspace: 'acme', slug: 'b', archived: false },
    ]);

    expect(result.requested).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.alreadyTracked).toBe(0);
    expect(result.notFound).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ fullName: 'acme/a' });
    expect(result.errors[0]?.error).toContain('400');
    // `b` still landed.
    expect(state.repositories.has('acme/b')).toBe(true);
  });

  it('does NOT reconcile per-repo flags from YAML on existing rows (DB is canonical)', async () => {
    // Pre-existing row was archived after a rename. The seed YAML
    // happens to disagree (archived: false) — bootstrap should leave
    // the DB untouched.
    const { store } = createFakeStore();
    await store.insertRepositoryWithSyncState({
      bitbucketUuid: '{r1}',
      workspace: 'acme',
      project: 'PLATFORM',
      slug: 'api-server',
      fullName: 'acme/api-server',
      archived: true,
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await bootstrapTrackedRepositories(deps, [
      { workspace: 'acme', slug: 'api-server', archived: false },
    ]);

    expect(result.alreadyTracked).toBe(1);
    const row = await store.findRepositoryByFullName('acme/api-server');
    // DB value preserved — YAML did not write through.
    expect(row?.archived).toBe(true);
    // No HTTP call either — already-tracked short-circuits before BB lookup.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seeds per-repo flags from YAML on first insert', async () => {
    // Brand-new repo: YAML's `archived` value becomes the initial
    // column value.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        uuid: '{r-new}',
        slug: 'fresh',
        full_name: 'acme/fresh',
        workspace: { slug: 'acme' },
        project: { key: 'PLATFORM' },
      }),
    );
    const { store } = createFakeStore();
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await bootstrapTrackedRepositories(deps, [{ workspace: 'acme', slug: 'fresh', archived: true }]);

    const row = await store.findRepositoryByFullName('acme/fresh');
    expect(row?.archived).toBe(true);
  });
});
