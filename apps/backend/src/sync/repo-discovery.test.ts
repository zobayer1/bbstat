import { describe, it, expect, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { BitbucketRepoSummary } from '../bitbucket/repositories.js';
import type { CacheClient } from '../cache/redis.js';
import type { RepositoryInsertInput, RepositoryRow } from './discovery-store.js';
import { runRepoDiscoverySweep, type RepoDiscoveryDeps } from './repo-discovery.js';

const CURSOR_KEY = 'bbstat:repo-discovery-cursor';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function reposPage(values: BitbucketRepoSummary[]): Response {
  return jsonResponse({ pagelen: 100, values });
}
function makeClient(fetchFn: typeof globalThis.fetch): BitbucketClient {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@example.com',
    token: 'tok',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
  });
}
function repo(over: Partial<BitbucketRepoSummary> & { slug: string; updated_on: string }): BitbucketRepoSummary {
  return {
    uuid: `{${over.slug}}`,
    full_name: `acme/${over.slug}`,
    workspace: { slug: 'acme' },
    is_private: true,
    ...over,
  };
}

// Map-backed Redis stand-in — the sweep only touches get/set/del.
function makeCache(initial?: string): { cache: CacheClient; map: Map<string, string> } {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(CURSOR_KEY, initial);
  const cache = {
    async get(k: string) {
      return map.get(k) ?? null;
    },
    async set(k: string, v: string) {
      map.set(k, v);
    },
    async del(k: string) {
      map.delete(k);
    },
  } as unknown as CacheClient;
  return { cache, map };
}

function repoRow(input: RepositoryInsertInput): RepositoryRow {
  return {
    id: 1,
    bitbucketUuid: input.bitbucketUuid,
    workspace: input.workspace,
    project: input.project,
    slug: input.slug,
    fullName: input.fullName,
    archived: input.archived,
    syncExcluded: false,
    syncExcludeReason: null,
    diffStatsExcludePatterns: [],
  };
}

function makeStore(tracked: Set<string> = new Set()): {
  store: Pick<RepoDiscoveryDeps['store'], 'insertRepositoryWithSyncState' | 'findRepositoryByFullName'>;
  insertedCalls: string[];
} {
  const insertedCalls: string[] = [];
  const store = {
    async insertRepositoryWithSyncState(input: RepositoryInsertInput) {
      insertedCalls.push(input.fullName);
      const isNew = !tracked.has(input.fullName);
      if (isNew) tracked.add(input.fullName);
      return { row: repoRow(input), inserted: isNew };
    },
    async findRepositoryByFullName(fullName: string) {
      return tracked.has(fullName)
        ? repoRow({
            bitbucketUuid: 'x',
            workspace: 'acme',
            project: null,
            slug: fullName,
            fullName,
            archived: false,
          })
        : null;
    },
  };
  return { store, insertedCalls };
}

function makeDeps(
  fetchFn: typeof globalThis.fetch,
  cache: CacheClient,
  store: RepoDiscoveryDeps['store'],
): RepoDiscoveryDeps {
  return { client: makeClient(fetchFn), cache, store, workspace: 'acme' };
}

const OPTS = { maxReposPerSweep: 100, budgetThreshold: 10 };

describe('runRepoDiscoverySweep', () => {
  it('skips entirely when the budget is below threshold', async () => {
    const fetchMock = vi.fn();
    const { cache } = makeCache();
    const { store } = makeStore();
    const result = await runRepoDiscoverySweep(
      makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store),
      {
        maxReposPerSweep: 100,
        budgetThreshold: 1_000_000_000,
      },
    );
    expect(result.stoppedReason).toBe('budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('backfills untracked repos and advances the cursor to the newest updated_on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reposPage([
          repo({ slug: 'a', updated_on: '2020-01-01T00:00:00+00:00' }),
          repo({ slug: 'b', updated_on: '2021-06-01T00:00:00+00:00' }),
          repo({ slug: 'c', updated_on: '2022-12-31T00:00:00+00:00' }),
        ]),
      );
    const { cache, map } = makeCache();
    const { store, insertedCalls } = makeStore();
    const result = await runRepoDiscoverySweep(
      makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store),
      OPTS,
    );

    expect(result.scanned).toBe(3);
    expect(result.added).toEqual(['acme/a', 'acme/b', 'acme/c']);
    expect(result.newCursor).toBe('2022-12-31T00:00:00+00:00');
    expect(insertedCalls).toHaveLength(3);
    expect(map.get(CURSOR_KEY)).toBe('2022-12-31T00:00:00+00:00');
  });

  it('uses the seed cursor on first run (no stored cursor)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reposPage([]));
    const { cache } = makeCache(); // empty → seed
    const { store } = makeStore();
    await runRepoDiscoverySweep(makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store), OPTS);
    // First run with no stored cursor → BBQL `q` lower bound carries the seed
    // (epoch) date and the walk is sorted by updated_on. Loose substring
    // checks avoid asserting exact URL encoding of the quoted `q` value.
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('sort=updated_on');
    expect(url).toContain('1970');
  });

  it('skips forks of repos outside the workspace, keeps internal forks', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      reposPage([
        repo({ slug: 'own', updated_on: '2020-01-01T00:00:00+00:00' }),
        repo({
          slug: 'ext-fork',
          updated_on: '2020-02-01T00:00:00+00:00',
          parent: { full_name: 'otherorg/upstream' },
        }),
        repo({
          slug: 'int-fork',
          updated_on: '2020-03-01T00:00:00+00:00',
          parent: { full_name: 'acme/upstream' },
        }),
      ]),
    );
    const { cache } = makeCache();
    const { store } = makeStore();
    const result = await runRepoDiscoverySweep(
      makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store),
      OPTS,
    );

    expect(result.skippedForks).toBe(1);
    expect(result.added).toEqual(['acme/own', 'acme/int-fork']);
    // Cursor still advances past the skipped fork.
    expect(result.newCursor).toBe('2020-03-01T00:00:00+00:00');
  });

  it('does not re-add an already-tracked repo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reposPage([
          repo({ slug: 'tracked', updated_on: '2020-01-01T00:00:00+00:00' }),
          repo({ slug: 'fresh', updated_on: '2020-02-01T00:00:00+00:00' }),
        ]),
      );
    const { cache } = makeCache();
    const { store } = makeStore(new Set(['acme/tracked']));
    const result = await runRepoDiscoverySweep(
      makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store),
      OPTS,
    );
    expect(result.added).toEqual(['acme/fresh']);
  });

  it('dry-run lists untracked candidates without inserting or advancing the cursor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reposPage([
          repo({ slug: 'tracked', updated_on: '2020-01-01T00:00:00+00:00' }),
          repo({ slug: 'new', updated_on: '2020-02-01T00:00:00+00:00' }),
        ]),
      );
    const { cache, map } = makeCache();
    const { store, insertedCalls } = makeStore(new Set(['acme/tracked']));
    const result = await runRepoDiscoverySweep(
      makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store),
      {
        ...OPTS,
        dryRun: true,
      },
    );
    expect(result.dryRun).toBe(true);
    expect(result.added).toEqual(['acme/new']); // only the untracked one
    expect(insertedCalls).toHaveLength(0); // no writes
    expect(map.has(CURSOR_KEY)).toBe(false); // cursor untouched
  });

  it('stops at the per-sweep cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reposPage([
          repo({ slug: 'a', updated_on: '2020-01-01T00:00:00+00:00' }),
          repo({ slug: 'b', updated_on: '2020-02-01T00:00:00+00:00' }),
          repo({ slug: 'c', updated_on: '2020-03-01T00:00:00+00:00' }),
        ]),
      );
    const { cache } = makeCache();
    const { store } = makeStore();
    const result = await runRepoDiscoverySweep(
      makeDeps(fetchMock as unknown as typeof globalThis.fetch, cache, store),
      {
        maxReposPerSweep: 2,
        budgetThreshold: 10,
      },
    );
    expect(result.scanned).toBe(2);
    expect(result.stoppedReason).toBe('page-cap');
  });
});
