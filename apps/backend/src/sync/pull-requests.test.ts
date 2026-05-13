// Unit tests for syncRepositoryPullRequests. Uses an in-memory PrStore
// fake and an injected fetch mock — same pattern as commits.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { BitbucketPullRequest } from '../bitbucket/pull-requests.js';
import type { PrStore, PrSyncStateRow, PullRequestInsertInput, PullRequestUpsertResult } from './pr-store.js';
import type { RepositoryHandle } from './commits.js';
import { syncRepositoryPullRequests } from './pull-requests.js';

interface FakePrStoreState {
  syncStateByRepo: Map<number, PrSyncStateRow>;
  prsByKey: Map<string, PullRequestInsertInput>; // `${repoId}:${bbId}`
  usersByUuid: Map<string, number>;
  upsertCalls: number;
  successCalls: Array<{ repositoryId: number; newCursorAt: Date | null; newCursorId: number | null; added: number }>;
}

function createFakePrStore(seed?: { state?: PrSyncStateRow[]; users?: Array<[string, number]> }): {
  store: PrStore;
  state: FakePrStoreState;
} {
  const state: FakePrStoreState = {
    syncStateByRepo: new Map(),
    prsByKey: new Map(),
    usersByUuid: new Map(),
    upsertCalls: 0,
    successCalls: [],
  };
  for (const row of seed?.state ?? []) state.syncStateByRepo.set(row.repositoryId, row);
  for (const [uuid, id] of seed?.users ?? []) state.usersByUuid.set(uuid, id);

  const store: PrStore = {
    async resolveUserIdsByUuid(uuids) {
      const map = new Map<string, number>();
      for (const u of uuids) {
        const id = state.usersByUuid.get(u);
        if (id !== undefined) map.set(u, id);
      }
      return map;
    },
    async upsertPullRequests(input): Promise<PullRequestUpsertResult> {
      state.upsertCalls++;
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
      return state.syncStateByRepo.get(repositoryId) ?? null;
    },
    async markPrSyncSuccess(repositoryId, update) {
      state.successCalls.push({
        repositoryId,
        newCursorAt: update.newCursor?.updatedAt ?? null,
        newCursorId: update.newCursor?.prId ?? null,
        added: update.addedOrUpdated,
      });
      const row = state.syncStateByRepo.get(repositoryId);
      if (row !== undefined) {
        state.syncStateByRepo.set(repositoryId, {
          ...row,
          ...(update.newCursor !== null
            ? { lastPrUpdatedAt: update.newCursor.updatedAt, lastPrId: update.newCursor.prId }
            : {}),
          prLastSyncedAt: new Date(),
          prTotalSynced: row.prTotalSynced + update.addedOrUpdated,
        });
      }
    },
  };
  return { store, state };
}

function makeRepo(repositoryId: number, slug = 'boing-server'): RepositoryHandle {
  return { repositoryId, workspace: 'tigerit', slug, fullName: `tigerit/${slug}`, diffStatsEnabled: false };
}

function makePrStateRow(repositoryId: number, cursor?: { updatedAt: Date; prId: number }): PrSyncStateRow {
  return {
    repositoryId,
    lastPrUpdatedAt: cursor?.updatedAt ?? null,
    lastPrId: cursor?.prId ?? null,
    prLastSyncedAt: null,
    prTotalSynced: 0,
  };
}

function makePr(over: Partial<BitbucketPullRequest> = {}): BitbucketPullRequest {
  return {
    id: 1,
    title: 'feat: thing',
    state: 'OPEN',
    source: { branch: { name: 'feature' }, commit: { hash: 'src-sha' } },
    destination: { branch: { name: 'main' }, commit: { hash: 'dst-sha' } },
    author: { uuid: '{author-uuid}' },
    created_on: '2026-05-08T12:00:00+00:00',
    updated_on: '2026-05-09T18:00:00+00:00',
    closed_on: null,
    comment_count: 0,
    task_count: 0,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function prsPage(values: BitbucketPullRequest[], next?: string): Response {
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

describe('syncRepositoryPullRequests — no sync_state row', () => {
  it("returns mode='no-state' and does not touch the API", async () => {
    const fetchMock = vi.fn();
    const { store, state } = createFakePrStore();
    const result = await syncRepositoryPullRequests(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store },
      makeRepo(1),
    );

    expect(result.mode).toBe('no-state');
    expect(result.fetched).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.successCalls).toEqual([]);
  });
});

describe('syncRepositoryPullRequests — cold mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('walks until exhaustion when no firstRunMaxPages cap is set', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(prsPage([makePr({ id: 1 }), makePr({ id: 2, updated_on: '2026-05-08T18:00:00+00:00' })])),
    );
    const { store } = createFakePrStore({ state: [makePrStateRow(1)] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryPullRequests(deps, makeRepo(1));

    expect(result.mode).toBe('cold');
    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.hitPageCap).toBe(false);
    expect(result.newCursor).toEqual({ updatedAt: '2026-05-09T18:00:00.000Z', prId: 1 });
  });

  it('respects firstRunMaxPages as a row cap (pages × 50, BB caps PR pagelen)', async () => {
    const prs = Array.from({ length: 100 }, (_, i) =>
      makePr({ id: 1000 - i, updated_on: new Date(Date.now() - i * 1000).toISOString() }),
    );
    fetchMock.mockImplementation(() => Promise.resolve(prsPage(prs)));
    const { store } = createFakePrStore({ state: [makePrStateRow(1)] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryPullRequests(deps, makeRepo(1), { firstRunMaxPages: 1 });

    expect(result.mode).toBe('cold');
    expect(result.fetched).toBe(50);
    expect(result.inserted).toBe(50);
    expect(result.hitPageCap).toBe(true);
  });

  it('resolves authors via resolveUserIdsByUuid (anonymous stays null)', async () => {
    fetchMock.mockResolvedValueOnce(
      prsPage([
        makePr({ id: 1, author: { uuid: '{known-user}' } }),
        makePr({ id: 2, author: undefined }), // anonymous / deleted account
      ]),
    );
    const { store, state } = createFakePrStore({
      state: [makePrStateRow(1)],
      users: [['{known-user}', 99]],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncRepositoryPullRequests(deps, makeRepo(1));

    expect(state.prsByKey.get('1:1')?.authorUserId).toBe(99);
    expect(state.prsByKey.get('1:2')?.authorUserId).toBeNull();
  });

  it('persists optional fields (closed_on, source/destination commit) when present and null when absent', async () => {
    fetchMock.mockResolvedValueOnce(
      prsPage([
        makePr({
          id: 1,
          state: 'MERGED',
          closed_on: '2026-05-10T12:00:00+00:00',
          source: { branch: { name: 'feat' }, commit: { hash: 'src-sha' } },
          destination: { branch: { name: 'main' }, commit: { hash: 'dst-sha' } },
        }),
        makePr({
          id: 2,
          state: 'DECLINED',
          closed_on: null,
          source: { branch: { name: 'feat' } },
          destination: { branch: { name: 'main' } },
        }),
      ]),
    );
    const { store, state } = createFakePrStore({ state: [makePrStateRow(1)] });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    await syncRepositoryPullRequests(deps, makeRepo(1));

    const pr1 = state.prsByKey.get('1:1')!;
    expect(pr1.state).toBe('MERGED');
    expect(pr1.bitbucketClosedAt).toEqual(new Date('2026-05-10T12:00:00+00:00'));
    expect(pr1.sourceSha).toBe('src-sha');
    expect(pr1.destinationSha).toBe('dst-sha');

    const pr2 = state.prsByKey.get('1:2')!;
    expect(pr2.state).toBe('DECLINED');
    expect(pr2.bitbucketClosedAt).toBeNull();
    expect(pr2.sourceSha).toBeNull();
    expect(pr2.destinationSha).toBeNull();
  });
});

describe('syncRepositoryPullRequests — delta mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('stops at first PR with updated_on < cursor', async () => {
    const cursor = new Date('2026-05-08T12:00:00+00:00');
    fetchMock.mockResolvedValueOnce(
      prsPage([
        makePr({ id: 10, updated_on: '2026-05-09T18:00:00+00:00' }), // newer → ingest
        makePr({ id: 9, updated_on: '2026-05-08T12:00:00+00:00' }), // equal → ingest (idempotent)
        makePr({ id: 8, updated_on: '2026-05-07T10:00:00+00:00' }), // older → STOP
      ]),
    );
    const { store, state } = createFakePrStore({
      state: [makePrStateRow(1, { updatedAt: cursor, prId: 9 })],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryPullRequests(deps, makeRepo(1));

    expect(result.mode).toBe('delta');
    expect(result.fetched).toBe(2);
    expect(result.hitKnownCursor).toBe(true);
    // Cursor advances to the head of the batch.
    expect(result.newCursor).toEqual({ updatedAt: '2026-05-09T18:00:00.000Z', prId: 10 });
    expect(state.prsByKey.size).toBe(2);
  });

  it('empty batch leaves cursor untouched (newCursor=null) and still stamps pr_last_synced_at', async () => {
    const cursor = new Date('2026-05-09T18:00:00+00:00');
    fetchMock.mockResolvedValueOnce(
      prsPage([
        makePr({ id: 9, updated_on: '2026-05-08T12:00:00+00:00' }), // older → STOP immediately
      ]),
    );
    const { store, state } = createFakePrStore({
      state: [makePrStateRow(1, { updatedAt: cursor, prId: 10 })],
    });
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryPullRequests(deps, makeRepo(1));

    expect(result.fetched).toBe(0);
    expect(result.newCursor).toBeNull();
    // markPrSyncSuccess still called (so pr_last_synced_at stamps), but
    // newCursor is null → store leaves last_pr_updated_at/id untouched.
    expect(state.successCalls).toHaveLength(1);
    expect(state.successCalls[0]?.newCursorAt).toBeNull();
  });

  it('PR state mutation (OPEN → MERGED) propagates via upsert UPDATE path', async () => {
    const { store, state } = createFakePrStore({ state: [makePrStateRow(1)] });
    // Seed the store with an OPEN PR.
    await store.upsertPullRequests([
      {
        repositoryId: 1,
        bitbucketPrId: 42,
        title: 'feat: original',
        state: 'OPEN',
        authorUserId: null,
        sourceBranch: 'feat',
        destinationBranch: 'main',
        sourceSha: 'src-sha',
        destinationSha: 'dst-sha',
        commentCount: 0,
        taskCount: 0,
        bitbucketCreatedAt: new Date('2026-05-08T12:00:00+00:00'),
        bitbucketUpdatedAt: new Date('2026-05-08T12:00:00+00:00'),
        bitbucketClosedAt: null,
      },
    ]);
    // Subsequent BB pull returns the same PR with MERGED + new updated_on.
    fetchMock.mockResolvedValueOnce(
      prsPage([
        makePr({
          id: 42,
          state: 'MERGED',
          closed_on: '2026-05-10T12:00:00+00:00',
          updated_on: '2026-05-10T12:00:00+00:00',
        }),
      ]),
    );
    const deps = { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), store };

    const result = await syncRepositoryPullRequests(deps, makeRepo(1));

    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);
    const pr = state.prsByKey.get('1:42')!;
    expect(pr.state).toBe('MERGED');
    expect(pr.bitbucketClosedAt).toEqual(new Date('2026-05-10T12:00:00+00:00'));
  });
});
