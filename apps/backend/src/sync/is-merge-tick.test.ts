// Unit tests for isMergeBackfillOneRepo / runIsMergeBackfillTick.
// Modeled on deepen-backfill.test.ts: in-memory CommitStore + fake
// fetch driving paginateCommits.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import { BitbucketApiError } from '../bitbucket/errors.js';
import type { CommitStore, IsMergeBackfillCandidate } from './commit-store.js';
import { isMergeBackfillOneRepo, runIsMergeBackfillTick } from './is-merge-tick.js';

interface FakeState {
  candidates: IsMergeBackfillCandidate[];
  attempts: number[];
  cursorAdvances: Array<{ repositoryId: number; cursorSha: string }>;
  marksComplete: number[];
  updates: Array<{ repositoryId: number; entries: Array<{ sha: string; isMerge: boolean }> }>;
}

function makeStore(seed: Partial<FakeState> = {}): { store: CommitStore; state: FakeState } {
  const state: FakeState = {
    candidates: seed.candidates ?? [],
    attempts: [],
    cursorAdvances: [],
    marksComplete: [],
    updates: [],
  };
  const fail = (): never => {
    throw new Error('CommitStore method called from is-merge-tick test — unexpected');
  };
  const store: CommitStore = {
    resolveUserIdsByUuid: fail,
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
    async updateIsMergeBatch(repositoryId, entries) {
      state.updates.push({ repositoryId, entries });
      // Count entries that would flip is_merge — for these tests, we
      // assume every entry differs from the stored row, so updated
      // equals entries.length.
      return { updated: entries.length };
    },
    async pickRepoForIsMergeBackfill() {
      return state.candidates.shift() ?? null;
    },
    async markIsMergeBackfillAttempt(repositoryId) {
      state.attempts.push(repositoryId);
    },
    async advanceIsMergeBackfillCursor(repositoryId, cursorSha) {
      state.cursorAdvances.push({ repositoryId, cursorSha });
    },
    async markIsMergeBackfillComplete(repositoryId) {
      state.marksComplete.push(repositoryId);
    },
    resetSyncCursors: fail,
    resetDiffStatsForRepo: fail,
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

function commitsPage(values: Array<{ hash: string; parents?: number }>, next?: string): Response {
  const fullValues = values.map((v) => ({
    hash: v.hash,
    message: `msg ${v.hash}`,
    date: '2026-05-01T00:00:00+00:00',
    parents: Array.from({ length: v.parents ?? 1 }, (_, i) => ({ hash: `parent-${v.hash}-${i}` })),
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

const COLD: IsMergeBackfillCandidate = {
  repositoryId: 7,
  workspace: 'tigerit',
  slug: 'boing',
  fullName: 'tigerit/boing',
  cursorSha: null,
};

const WARM: IsMergeBackfillCandidate = {
  ...COLD,
  cursorSha: 'sha-cursor',
};

describe('isMergeBackfillOneRepo', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('returns null when the queue is empty', async () => {
    const { store } = makeStore({ candidates: [] });
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isMergeBackfillOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cold start: walks /commits newest-first, marks complete when paginator exhausts', async () => {
    const { store, state } = makeStore({ candidates: [COLD] });
    // Three commits, the middle one a merge. No `next` → reached root.
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        { hash: 'sha-a', parents: 1 },
        { hash: 'sha-b', parents: 2 },
        { hash: 'sha-c', parents: 1 },
      ]),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isMergeBackfillOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(result?.fetched).toBe(3);
    expect(result?.reachedRoot).toBe(true);
    expect(result?.hitPageCap).toBe(false);
    expect(state.marksComplete).toEqual([7]);
    expect(state.cursorAdvances).toEqual([]);
    expect(state.updates).toEqual([
      {
        repositoryId: 7,
        entries: [
          { sha: 'sha-a', isMerge: false },
          { sha: 'sha-b', isMerge: true },
          { sha: 'sha-c', isMerge: false },
        ],
      },
    ]);
  });

  it('resume: passes include=<cursorSha> and skips the seed sha', async () => {
    const { store, state } = makeStore({ candidates: [WARM] });
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        { hash: 'sha-cursor', parents: 1 },
        { hash: 'sha-older-1', parents: 1 },
        { hash: 'sha-older-2', parents: 2 },
      ]),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isMergeBackfillOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(fetchMock.mock.calls[0]?.[0]).toContain('include=sha-cursor');
    // Seed sha is skipped — only the two ancestors get bulk-updated.
    expect(state.updates[0]?.entries).toEqual([
      { sha: 'sha-older-1', isMerge: false },
      { sha: 'sha-older-2', isMerge: true },
    ]);
    expect(result?.fetched).toBe(2);
    expect(result?.reachedRoot).toBe(true);
    expect(state.marksComplete).toEqual([7]);
  });

  it('page cap fires: advances cursor to oldest walked sha, does NOT mark complete', async () => {
    const { store, state } = makeStore({ candidates: [COLD] });
    // Page 1 of 100 + a next URL; cap at maxPages=1 = 100 commits.
    const page = Array.from({ length: 100 }, (_, i) => ({ hash: `sha-${i.toString().padStart(3, '0')}` }));
    fetchMock.mockResolvedValueOnce(commitsPage(page, 'https://api.bitbucket.org/2.0/page/2'));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isMergeBackfillOneRepo({ client, store }, { maxPages: 1, budgetThreshold: 50 });

    expect(result?.fetched).toBe(100);
    expect(result?.hitPageCap).toBe(true);
    expect(result?.reachedRoot).toBe(false);
    expect(state.marksComplete).toEqual([]);
    expect(state.cursorAdvances).toEqual([{ repositoryId: 7, cursorSha: 'sha-099' }]);
  });

  it('404 on cursor sha: marks complete with seedMissing=true', async () => {
    const { store, state } = makeStore({ candidates: [WARM] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 404, body: { error: { message: 'not found' } } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isMergeBackfillOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(result?.seedMissing).toBe(true);
    expect(result?.reachedRoot).toBe(true);
    expect(state.marksComplete).toEqual([7]);
    expect(state.updates).toEqual([]);
  });

  it('always bumps last_run_at via markIsMergeBackfillAttempt, even when no commits walked', async () => {
    const { store, state } = makeStore({ candidates: [COLD] });
    fetchMock.mockResolvedValueOnce(commitsPage([]));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    await isMergeBackfillOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(state.attempts).toEqual([7]);
  });

  it('transient error (non-404, non-rate-limit): empty result, no cursor change, no complete', async () => {
    const { store, state } = makeStore({ candidates: [COLD] });
    fetchMock.mockRejectedValueOnce(new BitbucketApiError('/commits/x/y', 500, 'boom'));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isMergeBackfillOneRepo({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(result?.fetched).toBe(0);
    expect(result?.reachedRoot).toBe(false);
    expect(state.cursorAdvances).toEqual([]);
    expect(state.marksComplete).toEqual([]);
    // Attempt was still recorded so the round-robin advances.
    expect(state.attempts).toEqual([7]);
  });
});

describe('runIsMergeBackfillTick', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('drains multiple repos, returns queue-empty when the queue is exhausted', async () => {
    const { store, state } = makeStore({
      candidates: [
        { ...COLD, repositoryId: 1, fullName: 'tigerit/a' },
        { ...COLD, repositoryId: 2, fullName: 'tigerit/b' },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(commitsPage([{ hash: 'sha-a-1', parents: 1 }]))
      .mockResolvedValueOnce(commitsPage([{ hash: 'sha-b-1', parents: 2 }]));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await runIsMergeBackfillTick({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(result.stoppedReason).toBe('queue-empty');
    expect(result.repos.map((r) => r.repositoryId)).toEqual([1, 2]);
    expect(state.marksComplete.sort()).toEqual([1, 2]);
  });

  it('budget gate fires before scheduling, returns stoppedReason=budget', async () => {
    const { store } = makeStore({ candidates: [COLD] });
    // budget=10, pre-burn nothing — threshold 50 trips on the first check.
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { budget: 10 });

    const result = await runIsMergeBackfillTick({ client, store }, { maxPages: 5, budgetThreshold: 50 });

    expect(result.stoppedReason).toBe('budget');
    expect(result.repos).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
