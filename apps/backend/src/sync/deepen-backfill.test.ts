// Unit tests for deepenOneRepo. The function reaches into the BB client
// (via paginateCommits), the CommitStore (queue picking, oldest-sha
// lookup, insert, deepen state flips), and the BB-call budget gate. Tests
// inject all of those via in-memory fakes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';
import type {
  CommitInsertInput,
  CommitInsertResult,
  CommitStore,
  DeepenCandidate,
  PendingDiffStatCommit,
  SyncStateRow,
} from './commit-store.js';
import { deepenOneRepo, runDeepenTick } from './deepen-backfill.js';

interface FakeState {
  candidate: DeepenCandidate | null;
  oldestShaByRepo: Map<number, string | null>;
  syncStateByRepo: Map<number, SyncStateRow | null>;
  inserts: CommitInsertInput[];
  markedAttempt: number[];
  markedComplete: number[];
}

function makeStore(seed: Partial<FakeState> = {}): { store: CommitStore; state: FakeState } {
  const state: FakeState = {
    candidate: seed.candidate ?? null,
    oldestShaByRepo: seed.oldestShaByRepo ?? new Map(),
    // Default: no sync_state row known. The empty-sha branch of
    // deepenOneRepo treats `null` / missing as "cold mode hasn't
    // succeeded yet" — same behavior as the previous test fixture.
    syncStateByRepo: seed.syncStateByRepo ?? new Map(),
    inserts: [],
    markedAttempt: [],
    markedComplete: [],
  };
  const unreachable = (): never => {
    throw new Error('CommitStore method called from deepen test — unexpected');
  };
  const store: CommitStore = {
    async resolveUserIdsByUuid() {
      // Tests don't seed users — every author lands as null.
      return new Map();
    },
    async insertCommits(input): Promise<CommitInsertResult> {
      const insertedRows: Array<{ id: number; sha: string; authoredAt: Date }> = [];
      // Dedupe on (repo, sha) so we can simulate ON CONFLICT DO NOTHING.
      const existingKeys = new Set(state.inserts.map((i) => `${i.repositoryId}:${i.sha}`));
      let nextId = state.inserts.length + 1;
      for (const c of input) {
        const key = `${c.repositoryId}:${c.sha}`;
        if (!existingKeys.has(key)) {
          state.inserts.push(c);
          existingKeys.add(key);
          insertedRows.push({ id: nextId++, sha: c.sha, authoredAt: c.authoredAt });
        }
      }
      return { inserted: insertedRows.length, insertedRows };
    },
    async getSyncState(repositoryId) {
      return state.syncStateByRepo.get(repositoryId) ?? null;
    },
    markSyncRunning: unreachable as () => Promise<void>,
    markSyncSuccess: unreachable,
    markSyncFailed: unreachable,
    listPendingDiffStatCommits: unreachable as () => Promise<PendingDiffStatCommit[]>,
    updateCommitDiffStats: unreachable as () => Promise<void>,
    async getOldestCommitSha(repositoryId) {
      return state.oldestShaByRepo.get(repositoryId) ?? null;
    },
    async pickRepoForDeepening() {
      return state.candidate;
    },
    async markDeepenAttempt(repositoryId) {
      state.markedAttempt.push(repositoryId);
    },
    async markDeepenComplete(repositoryId) {
      state.markedComplete.push(repositoryId);
    },
    async updateIsMergeBatch(_repositoryId, entries) {
      return { updated: entries.length };
    },
    pickRepoForIsMergeBackfill: unreachable as () => Promise<null>,
    markIsMergeBackfillAttempt: unreachable as () => Promise<void>,
    advanceIsMergeBackfillCursor: unreachable as () => Promise<void>,
    markIsMergeBackfillComplete: unreachable as () => Promise<void>,
  };
  return { store, state };
}

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function jsonResponse({ status = 200, body = {}, headers = {} }: MockResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function commitsPage(values: Array<{ hash: string; date?: string }>, next?: string): Response {
  const fullValues = values.map((v) => ({
    hash: v.hash,
    message: `msg ${v.hash}`,
    date: v.date ?? '2026-05-01T00:00:00+00:00',
    parents: [],
    author: { raw: 'A <a@x>' },
  }));
  return jsonResponse({ body: { pagelen: 100, values: fullValues, ...(next !== undefined ? { next } : {}) } });
}

function makeClient(fetchFn: typeof globalThis.fetch, opts: { budget?: number } = {}): BitbucketClient {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@b.c',
    token: 't',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
    hourlyCallBudget: opts.budget ?? 1000,
  });
}

const REPO: DeepenCandidate = {
  repositoryId: 7,
  workspace: 'tigerit',
  slug: 'boing',
  fullName: 'tigerit/boing',
  oldestSha: 'sha-oldest',
};

describe('deepenOneRepo', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('returns null when no repo is queued for deepening', async () => {
    const { store } = makeStore({ candidate: null });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when the candidate has no oldest sha yet (cold mode hasnt run)', async () => {
    const { store, state } = makeStore({ candidate: { ...REPO, oldestSha: null } });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(result?.fetched).toBe(0);
    expect(state.markedAttempt).toEqual([7]);
    // Don't mark complete — wait for cold mode to land commits first.
    expect(state.markedComplete).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks complete when oldestSha is null AND last_sync_status=success (repo is empty on BB)', async () => {
    // Cold mode ran successfully but returned no commits — the repo is
    // genuinely empty on BB. Without this auto-mark, the repo would
    // cycle through every deepen tick forever via the "no oldest sha"
    // empty-result path.
    const { store, state } = makeStore({
      candidate: { ...REPO, oldestSha: null },
      syncStateByRepo: new Map([
        [
          7,
          {
            repositoryId: 7,
            lastSeenSha: null,
            lastSyncedAt: new Date('2026-05-13T22:20:00Z'),
            lastSyncStartedAt: new Date('2026-05-13T22:20:00Z'),
            lastSyncStatus: 'success' as const,
            lastSyncError: null,
            totalCommitsSynced: 0,
          } satisfies SyncStateRow,
        ],
      ]),
    });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(result?.fetched).toBe(0);
    expect(result?.reachedRoot).toBe(true);
    expect(state.markedAttempt).toEqual([7]);
    expect(state.markedComplete).toEqual([7]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT mark complete when oldestSha is null AND last_sync_status=failed (transient cold-mode failure)', async () => {
    const { store, state } = makeStore({
      candidate: { ...REPO, oldestSha: null },
      syncStateByRepo: new Map([
        [
          7,
          {
            repositoryId: 7,
            lastSeenSha: null,
            lastSyncedAt: null,
            lastSyncStartedAt: new Date('2026-05-13T22:20:00Z'),
            lastSyncStatus: 'failed' as const,
            lastSyncError: 'something went wrong',
            totalCommitsSynced: 0,
          } satisfies SyncStateRow,
        ],
      ]),
    });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(result?.reachedRoot).toBe(false);
    expect(state.markedComplete).toEqual([]);
  });

  it('walks backwards from the oldest sha, skips the seed, inserts the rest, marks complete when BB has no `next`', async () => {
    const { store, state } = makeStore({ candidate: REPO });
    // Single page: seed sha + 2 ancestors, no `next` URL → reached root.
    fetchMock.mockResolvedValueOnce(
      commitsPage([{ hash: 'sha-oldest' }, { hash: 'sha-anc-1' }, { hash: 'sha-anc-2' }]),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(result).toMatchObject({
      repositoryId: 7,
      fullName: 'tigerit/boing',
      fetched: 2,
      inserted: 2,
      reachedRoot: true,
      hitPageCap: false,
      seedMissing: false,
    });
    expect(state.inserts.map((i) => i.sha)).toEqual(['sha-anc-1', 'sha-anc-2']);
    expect(state.markedAttempt).toEqual([7]);
    expect(state.markedComplete).toEqual([7]);
  });

  it('stops at maxPages × 100 commits and reports hitPageCap without marking complete', async () => {
    const { store, state } = makeStore({ candidate: REPO });
    // First page: seed + 99 ancestors + `next` URL. We exit when the
    // batch reaches maxPages × 100 = 1 × 100 = 100 commits (excluding the
    // skipped seed) — but here we only ingest 99 since `maxPages: 1` and
    // the seed is filtered out separately.
    const ancestors = Array.from({ length: 99 }, (_, i) => ({ hash: `sha-anc-${i}` }));
    fetchMock.mockResolvedValueOnce(
      commitsPage([{ hash: 'sha-oldest' }, ...ancestors], 'https://api.bitbucket.org/2.0/.../commits?page=2'),
    );
    // Second page: 1 more ancestor, would have completed if we kept going.
    fetchMock.mockResolvedValueOnce(commitsPage([{ hash: 'sha-anc-100' }]));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 1, budgetThreshold: 100 });

    expect(result?.fetched).toBe(100); // 99 from page 1 + 1 from page 2 = 100, then cap fires
    expect(result?.inserted).toBe(100);
    expect(result?.hitPageCap).toBe(true);
    expect(result?.reachedRoot).toBe(false);
    // Page cap fired → don't mark complete (more history remains).
    expect(state.markedComplete).toEqual([]);
    expect(state.markedAttempt).toEqual([7]);
  });

  it('marks complete on a 404 against the seed sha (force-pushed history)', async () => {
    const { store, state } = makeStore({ candidate: REPO });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 404, body: { error: { message: 'not found' } } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(result?.seedMissing).toBe(true);
    expect(result?.reachedRoot).toBe(true);
    expect(state.markedComplete).toEqual([7]);
  });

  it('marks attempt but NOT complete on a transient 4xx (other than 404) and returns an empty result', async () => {
    const { store, state } = makeStore({ candidate: REPO });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 400, body: { error: { message: 'bad' } } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    // Transient errors return an empty result (not null) so a runDeepenTick
    // loop can move on to the next candidate without aborting.
    expect(result).not.toBeNull();
    expect(result?.fetched).toBe(0);
    expect(result?.reachedRoot).toBe(false);
    expect(state.markedAttempt).toEqual([7]);
    expect(state.markedComplete).toEqual([]);
  });

  it('recomputes commit_daily and invalidates user-summary cache when rollupStore + userSummaryCache are wired', async () => {
    const { store } = makeStore({ candidate: REPO });
    // Two ancestors across two distinct UTC days — the recompute range
    // should span both. The user-summary cache should be invalidated for
    // every user the rollup-store reports as affected.
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        { hash: 'sha-oldest', date: '2026-05-03T01:00:00+00:00' },
        { hash: 'sha-anc-1', date: '2026-05-02T12:00:00+00:00' },
        { hash: 'sha-anc-2', date: '2026-05-01T03:00:00+00:00' },
      ]),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const recomputeCalls: Array<{ repositoryId: number; range: { sinceDay: string; untilDay: string } }> = [];
    const listCalls: Array<{ repositoryId: number; range: { sinceDay: string; untilDay: string } }> = [];
    const invalidatedUserIds: number[] = [];
    const rollupStore = {
      async recomputeCommitDailyForRepo(
        repositoryId: number,
        range: { sinceDay: string; untilDay: string },
      ): Promise<{ rowsAffected: number }> {
        recomputeCalls.push({ repositoryId, range });
        return { rowsAffected: 2 };
      },
      async listAffectedUserIdsForRepo(
        repositoryId: number,
        range: { sinceDay: string; untilDay: string },
      ): Promise<number[]> {
        listCalls.push({ repositoryId, range });
        return [101, 202];
      },
      async rebuildAll(): Promise<{ rowsAffected: number }> {
        throw new Error('rebuildAll should not be called from deepen hook');
      },
    };
    const userSummaryCache = {
      async invalidate(userId: number): Promise<void> {
        invalidatedUserIds.push(userId);
      },
      // Other UserSummaryCache members not invoked by the deepen hook.
    } as unknown as UserSummaryCache;

    const result = await deepenOneRepo(
      { client, store, rollupStore, userSummaryCache },
      { maxPages: 5, budgetThreshold: 100 },
    );

    expect(result?.inserted).toBe(2);
    expect(recomputeCalls).toEqual([{ repositoryId: 7, range: { sinceDay: '2026-05-01', untilDay: '2026-05-02' } }]);
    expect(listCalls).toEqual([{ repositoryId: 7, range: { sinceDay: '2026-05-01', untilDay: '2026-05-02' } }]);
    expect(invalidatedUserIds.sort()).toEqual([101, 202]);
  });

  it('does not invoke rollup recompute when no inserts landed (force-pushed seed)', async () => {
    const { store } = makeStore({ candidate: REPO });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 404, body: { error: { message: 'not found' } } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    let recomputeCallCount = 0;
    const rollupStore = {
      async recomputeCommitDailyForRepo(): Promise<{ rowsAffected: number }> {
        recomputeCallCount++;
        return { rowsAffected: 0 };
      },
      async listAffectedUserIdsForRepo(): Promise<number[]> {
        return [];
      },
      async rebuildAll(): Promise<{ rowsAffected: number }> {
        return { rowsAffected: 0 };
      },
    };

    const result = await deepenOneRepo({ client, store, rollupStore }, { maxPages: 5, budgetThreshold: 100 });

    expect(result?.seedMissing).toBe(true);
    expect(recomputeCallCount).toBe(0);
  });

  it('honors explicitRepo (admin path) by skipping pickRepoForDeepening and resolving seed fresh', async () => {
    const { store, state } = makeStore({
      candidate: null, // queue picks nothing — but explicitRepo overrides
      oldestShaByRepo: new Map([[42, 'sha-explicit-seed']]),
    });
    fetchMock.mockResolvedValueOnce(commitsPage([{ hash: 'sha-explicit-seed' }, { hash: 'sha-anc-1' }]));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await deepenOneRepo(
      { client, store },
      { maxPages: 5, budgetThreshold: 100 },
      {
        repositoryId: 42,
        workspace: 'tigerit',
        slug: 'force',
        fullName: 'tigerit/force',
      },
    );

    expect(result?.repositoryId).toBe(42);
    expect(result?.fetched).toBe(1);
    expect(state.markedComplete).toEqual([42]);
  });
});

describe('runDeepenTick', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('drains the queue across multiple repos in one tick when budget allows', async () => {
    // Use a stateful candidate-picker so each call returns a different
    // repo until the queue is empty. Mirrors the production store's
    // round-robin behavior.
    const remaining: DeepenCandidate[] = [
      { repositoryId: 1, workspace: 'tigerit', slug: 'a', fullName: 'tigerit/a', oldestSha: 'a-seed' },
      { repositoryId: 2, workspace: 'tigerit', slug: 'b', fullName: 'tigerit/b', oldestSha: 'b-seed' },
      { repositoryId: 3, workspace: 'tigerit', slug: 'c', fullName: 'tigerit/c', oldestSha: 'c-seed' },
    ];
    const { store, state } = makeStore({});
    store.pickRepoForDeepening = async () => remaining.shift() ?? null;

    fetchMock.mockImplementation((url: string) => {
      const sha = url.match(/include=([a-z-]+)/)?.[1];
      const responses: Record<string, Response> = {
        'a-seed': commitsPage([{ hash: 'a-seed' }, { hash: 'a-anc' }]),
        'b-seed': commitsPage([{ hash: 'b-seed' }, { hash: 'b-anc' }]),
        'c-seed': commitsPage([{ hash: 'c-seed' }, { hash: 'c-anc' }]),
      };
      return Promise.resolve(responses[sha ?? ''] ?? jsonResponse({ body: { values: [] } }));
    });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const tick = await runDeepenTick({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(tick.repos).toHaveLength(3);
    expect(tick.stoppedReason).toBe('queue-empty');
    expect(state.markedComplete.sort()).toEqual([1, 2, 3]);
  });

  it('stops with stoppedReason=budget when getBudgetRemaining falls below threshold', async () => {
    const remaining: DeepenCandidate[] = [
      { repositoryId: 1, workspace: 'tigerit', slug: 'a', fullName: 'tigerit/a', oldestSha: 'a-seed' },
      { repositoryId: 2, workspace: 'tigerit', slug: 'b', fullName: 'tigerit/b', oldestSha: 'b-seed' },
      { repositoryId: 3, workspace: 'tigerit', slug: 'c', fullName: 'tigerit/c', oldestSha: 'c-seed' },
    ];
    const { store } = makeStore({});
    store.pickRepoForDeepening = async () => remaining.shift() ?? null;

    // Each response is a single page that pushes us to root for that
    // repo. Total BB calls: 3 (one per repo).
    fetchMock.mockImplementation((url: string) => {
      const sha = url.match(/include=([a-z-]+)/)?.[1] ?? 'x';
      return Promise.resolve(commitsPage([{ hash: sha }, { hash: `${sha}-anc` }]));
    });
    // Budget tight: 102 total, threshold 100. First iteration: budget
    // starts at 102 (>=100) → runs, consumes ~1 call → 101. Loop check:
    // 101 >= 100 → still runs, consumes ~1 → 100. Loop check: 100 >= 100
    // → runs, consumes 1 → 99. Loop check: 99 < 100 → stops with
    // stoppedReason=budget after 3 repos. To force an earlier stop, pre-
    // seed the ledger.
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { budget: 102 });
    // Pre-seed 2 calls so we have budget headroom for exactly one repo.
    // @ts-expect-error — exercising the private ledger for test seeding.
    client.callTimestamps.push(Date.now(), Date.now());

    const tick = await runDeepenTick({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(tick.stoppedReason).toBe('budget');
    expect(tick.repos.length).toBeLessThan(3);
  });

  it('stops with stoppedReason=rotation-complete after one full pass when every repo has oldestSha=null', async () => {
    // Pre-bug behavior: the empty-result path (no oldest sha) doesn't
    // consume budget and doesn't mark the repo complete, so the picker
    // would keep rotating through the same set of repos forever, spamming
    // logs at 100% CPU. Now: each repo gets exactly one attempt per tick;
    // a repeat repositoryId terminates the loop cleanly.
    const remaining: DeepenCandidate[] = [
      { repositoryId: 1, workspace: 'tigerit', slug: 'a', fullName: 'tigerit/a', oldestSha: null },
      { repositoryId: 2, workspace: 'tigerit', slug: 'b', fullName: 'tigerit/b', oldestSha: null },
    ];
    const { store, state } = makeStore({});
    // Production picker emits the candidate then rotates to the next; on
    // wrap-around it cycles back to the first. Mirror that with a counter.
    let i = 0;
    store.pickRepoForDeepening = async () => remaining[i++ % remaining.length] ?? null;
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const tick = await runDeepenTick({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(tick.stoppedReason).toBe('rotation-complete');
    // Two unique repos PUSHED to repos[] (first time each is seen); the
    // third pick (repo 1 again) marks attempt but never gets pushed,
    // because the seen-check fires before push.
    expect(tick.repos).toHaveLength(2);
    expect(tick.repos.every((r) => r.fetched === 0)).toBe(true);
    // markedAttempt is `[1, 2, 1]` — `deepenOneRepo` always marks attempt
    // before the orchestrator's dedupe runs. That's fine: the repeated
    // mark just bumps the same timestamp; no per-repo damage.
    expect(state.markedAttempt.sort()).toEqual([1, 1, 2]);
    // No BB calls — empty-sha path short-circuits before paginateCommits.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops with stoppedReason=rate-limited when BB exhausts the client retry budget mid-tick', async () => {
    // Two repos in the queue. First repo's request keeps returning 429
    // until the client's in-request retries (default 3 → 4 attempts total)
    // run out, at which point it throws BitbucketRateLimitError. Deepen
    // catches that, returns rateLimited: true, and runDeepenTick stops
    // BEFORE touching the second repo.
    const remaining: DeepenCandidate[] = [
      { repositoryId: 1, workspace: 'tigerit', slug: 'a', fullName: 'tigerit/a', oldestSha: 'a-seed' },
      { repositoryId: 2, workspace: 'tigerit', slug: 'b', fullName: 'tigerit/b', oldestSha: 'b-seed' },
    ];
    const { store } = makeStore({});
    store.pickRepoForDeepening = async () => remaining.shift() ?? null;

    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ status: 429, headers: { 'retry-after': '0' }, body: {} })),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const tick = await runDeepenTick({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(tick.stoppedReason).toBe('rate-limited');
    expect(tick.repos).toHaveLength(1);
    expect(tick.repos[0]?.rateLimited).toBe(true);
    expect(tick.repos[0]?.fullName).toBe('tigerit/a');
    // Second repo never picked → still in the queue for next tick.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.fullName).toBe('tigerit/b');
  });

  it('skips entirely and returns stoppedReason=budget when no budget headroom at start', async () => {
    const { store } = makeStore({
      candidate: { repositoryId: 1, workspace: 't', slug: 'a', fullName: 't/a', oldestSha: 'seed' },
    });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { budget: 50 });

    const tick = await runDeepenTick({ client, store }, { maxPages: 5, budgetThreshold: 100 });

    expect(tick.repos).toEqual([]);
    expect(tick.stoppedReason).toBe('budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
