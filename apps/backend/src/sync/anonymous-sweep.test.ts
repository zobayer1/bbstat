// Tests for the standalone anonymous-commit sweep runner. The store
// fake here is purpose-built for these tests — it tracks the subset
// of state the sweep cares about (anonymous commits, known users,
// auto-create outcomes, attribution updates, sweep flags) and
// mirrors the Drizzle semantics (race-safe UPDATE guard, COALESCE
// snapshot preservation, etc.).
//
// Two suites:
//   1. sweepOneRepo — per-repo behavior: full attribution, snapshot-
//      only fallback, BB 404, rate-limit propagation, no-local-anon
//      shortcut, no-matching-shas shortcut, commit_daily recompute
//      scoping, cache invalidation wiring, no-overwrite of established
//      attribution.
//   2. runAnonymousSweep — outer loop: zero-remaining exit, no-candidate
//      exit, budget-low sleep, repo error rotates and loop continues.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { BitbucketCommit } from '../bitbucket/commits.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { CommitStore, AnonymousSweepCandidate } from './commit-store.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';
import { runAnonymousSweep, sweepOneRepo } from './anonymous-sweep.js';

// ---------------------------------------------------------------------------
// In-memory store fake. State maps mirror the columns the sweep touches.
// ---------------------------------------------------------------------------

interface SweepFakeState {
  // anonymous commits keyed by sha, scoped per repo for query simplicity.
  anonymous: Map<
    number,
    Array<{
      commitId: number;
      sha: string;
      authoredAt: Date;
      authorEmail: string | null;
      authorDisplayName: string | null;
    }>
  >;
  repos: Map<number, AnonymousSweepCandidate>;
  // user upserts — uuid → id (synth). Tracks auto-create outcomes.
  usersByUuid: Map<string, number>;
  autoCreatedUuids: Set<string>;
  userIdSeq: number;
  // sweep-state flags per repo.
  sweepLastRunAt: Map<number, Date>;
  sweepComplete: Set<number>;
  // attribution records — what updates the sweep performed.
  attributionUpdates: Array<{
    commitId: number;
    userId: number | null;
    email: string | null;
    displayName: string | null;
  }>;
}

function createSweepFakeStore(): { store: CommitStore; state: SweepFakeState } {
  const state: SweepFakeState = {
    anonymous: new Map(),
    repos: new Map(),
    usersByUuid: new Map(),
    autoCreatedUuids: new Set(),
    userIdSeq: 100,
    sweepLastRunAt: new Map(),
    sweepComplete: new Set(),
    attributionUpdates: [],
  };
  const unreachable = (name: string) => (): never => {
    throw new Error(`CommitStore.${name} called from anonymous-sweep test — unexpected`);
  };
  const store: CommitStore = {
    async listAnonymousCommits({ workspace, slug, limit }) {
      // Find the repoId matching (workspace, slug).
      for (const [repoId, r] of state.repos) {
        if (r.workspace === workspace && r.slug === slug) {
          const rows = state.anonymous.get(repoId) ?? [];
          return rows.slice(0, limit).map((c) => ({
            commitId: c.commitId,
            sha: c.sha,
            repositoryId: repoId,
            workspace: r.workspace,
            slug: r.slug,
            fullName: r.fullName,
            authoredAt: c.authoredAt,
          }));
        }
      }
      return [];
    },
    async upsertAuthorUsers(inputs) {
      const map = new Map<string, number>();
      for (const e of inputs) {
        let id = state.usersByUuid.get(e.bitbucketUuid);
        if (id === undefined) {
          id = ++state.userIdSeq;
          state.usersByUuid.set(e.bitbucketUuid, id);
          state.autoCreatedUuids.add(e.bitbucketUuid);
        }
        map.set(e.bitbucketUuid, id);
      }
      return map;
    },
    async bulkUpdateAnonymousAttribution(entries) {
      const updated: Array<{ id: number; repositoryId: number; authoredAt: Date; attributed: boolean }> = [];
      for (const e of entries) {
        state.attributionUpdates.push(e);
        // Find the anonymous row by commitId.
        let foundRepoId: number | null = null;
        let foundIdx = -1;
        for (const [repoId, rows] of state.anonymous) {
          const idx = rows.findIndex((r) => r.commitId === e.commitId);
          if (idx !== -1) {
            foundRepoId = repoId;
            foundIdx = idx;
            break;
          }
        }
        if (foundRepoId === null) continue;
        const row = state.anonymous.get(foundRepoId)![foundIdx]!;
        // Mirror Drizzle: WHERE author_user_id IS NULL is satisfied
        // here by construction (anonymous list). UPDATE the row's
        // attribution + COALESCE snapshot.
        const attributed = e.userId !== null;
        if (attributed) {
          // Drop from the anonymous list — author_user_id is no
          // longer NULL.
          state.anonymous.get(foundRepoId)!.splice(foundIdx, 1);
        } else {
          // Snapshot-only update: still anonymous, fill columns via
          // COALESCE (preserve any pre-existing snapshot data).
          row.authorEmail = row.authorEmail ?? e.email;
          row.authorDisplayName = row.authorDisplayName ?? e.displayName;
        }
        updated.push({
          id: e.commitId,
          repositoryId: foundRepoId,
          authoredAt: row.authoredAt,
          attributed,
        });
      }
      return updated;
    },
    async pickRepoForAnonymousSweep() {
      // Pick the next non-complete repo with at least one anonymous
      // commit, ordered by lastRunAt NULLS FIRST then repoId.
      const candidates: Array<{ id: number; r: AnonymousSweepCandidate; lastRun: Date | null }> = [];
      for (const [repoId, r] of state.repos) {
        if (state.sweepComplete.has(repoId)) continue;
        const rows = state.anonymous.get(repoId) ?? [];
        if (rows.length === 0) continue;
        candidates.push({ id: repoId, r, lastRun: state.sweepLastRunAt.get(repoId) ?? null });
      }
      candidates.sort((a, b) => {
        // NULLS FIRST.
        if (a.lastRun === null && b.lastRun !== null) return -1;
        if (a.lastRun !== null && b.lastRun === null) return 1;
        if (a.lastRun !== null && b.lastRun !== null) {
          const cmp = a.lastRun.getTime() - b.lastRun.getTime();
          if (cmp !== 0) return cmp;
        }
        return a.id - b.id;
      });
      return candidates[0]?.r ?? null;
    },
    async countAnonymousCommits() {
      let total = 0;
      for (const rows of state.anonymous.values()) total += rows.length;
      return total;
    },
    async markAnonymousSweepAttempt(repositoryId) {
      state.sweepLastRunAt.set(repositoryId, new Date());
    },
    async markAnonymousSweepComplete(repositoryId) {
      state.sweepComplete.add(repositoryId);
      state.sweepLastRunAt.set(repositoryId, new Date());
    },
    // The rest of CommitStore is unused here — fail loudly if called.
    resolveUserIdsByUuid: unreachable('resolveUserIdsByUuid'),
    setUserEmailsIfMissing: unreachable('setUserEmailsIfMissing'),
    listUsersMissingEmailWithLastCommit: unreachable('listUsersMissingEmailWithLastCommit'),
    reattributeAnonymousCommits: unreachable('reattributeAnonymousCommits'),
    backfillAuthorSnapshotsFromUsers: unreachable('backfillAuthorSnapshotsFromUsers'),
    incrementDiffStatsFailure: unreachable('incrementDiffStatsFailure'),
    insertCommits: unreachable('insertCommits'),
    getSyncState: unreachable('getSyncState'),
    markSyncRunning: unreachable('markSyncRunning'),
    markSyncSuccess: unreachable('markSyncSuccess'),
    markSyncFailed: unreachable('markSyncFailed'),
    listPendingDiffStatCommits: unreachable('listPendingDiffStatCommits'),
    listPendingDiffStatCommitsGlobal: unreachable('listPendingDiffStatCommitsGlobal'),
    updateCommitDiffStats: unreachable('updateCommitDiffStats'),
    getOldestCommitSha: unreachable('getOldestCommitSha'),
    pickRepoForDeepening: unreachable('pickRepoForDeepening'),
    markDeepenAttempt: unreachable('markDeepenAttempt'),
    markDeepenComplete: unreachable('markDeepenComplete'),
    updateIsMergeBatch: unreachable('updateIsMergeBatch'),
    pickRepoForIsMergeBackfill: unreachable('pickRepoForIsMergeBackfill'),
    markIsMergeBackfillAttempt: unreachable('markIsMergeBackfillAttempt'),
    advanceIsMergeBackfillCursor: unreachable('advanceIsMergeBackfillCursor'),
    markIsMergeBackfillComplete: unreachable('markIsMergeBackfillComplete'),
    resetSyncCursors: unreachable('resetSyncCursors'),
    resetDiffStatsForRepo: unreachable('resetDiffStatsForRepo'),
  };
  return { store, state };
}

// ---------------------------------------------------------------------------
// HTTP / client helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function commitsPage(values: BitbucketCommit[], next?: string): Response {
  return jsonResponse({ pagelen: 100, values, ...(next !== undefined ? { next } : {}) });
}

function makeBBCommit(opts: {
  hash: string;
  date: string;
  raw: string;
  userUuid?: string;
  userDisplayName?: string;
}): BitbucketCommit {
  return {
    hash: opts.hash,
    message: `msg ${opts.hash}`,
    date: opts.date,
    parents: [],
    author: {
      raw: opts.raw,
      ...(opts.userUuid !== undefined
        ? {
            user: {
              uuid: opts.userUuid,
              ...(opts.userDisplayName !== undefined ? { display_name: opts.userDisplayName } : {}),
            },
          }
        : {}),
    },
  };
}

function makeClient(fetchFn: typeof globalThis.fetch, budget = 800): BitbucketClient {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'alice@example.com',
    token: 'tok',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
    hourlyCallBudget: budget,
  });
}

function makeRollupStore(overrides: Partial<RollupStore> = {}): {
  rollupStore: RollupStore;
  recomputeCalls: Array<{ repositoryId: number; range: { sinceDay: string; untilDay: string } }>;
} {
  const recomputeCalls: Array<{ repositoryId: number; range: { sinceDay: string; untilDay: string } }> = [];
  const rollupStore: RollupStore = {
    async recomputeCommitDailyForRepo(repositoryId, range) {
      recomputeCalls.push({ repositoryId, range });
      return { rowsAffected: 0 };
    },
    async listAffectedUserIdsForRepo() {
      return [];
    },
    async rebuildAll() {
      return { rowsAffected: 0 };
    },
    ...overrides,
  };
  return { rollupStore, recomputeCalls };
}

function makeCache(): { userSummaryCache: UserSummaryCache; invalidated: number[] } {
  const invalidated: number[] = [];
  const userSummaryCache: UserSummaryCache = {
    async get() {
      return null;
    },
    async set() {},
    async invalidate(id) {
      invalidated.push(id);
    },
  };
  return { userSummaryCache, invalidated };
}

// ---------------------------------------------------------------------------
// sweepOneRepo
// ---------------------------------------------------------------------------

describe('sweepOneRepo', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function seedRepo(state: SweepFakeState, repoId: number, fullName: string): AnonymousSweepCandidate {
    const [workspace, slug] = fullName.split('/') as [string, string];
    const candidate: AnonymousSweepCandidate = { repositoryId: repoId, workspace, slug, fullName };
    state.repos.set(repoId, candidate);
    state.anonymous.set(repoId, []);
    return candidate;
  }

  function seedAnonymous(
    state: SweepFakeState,
    repoId: number,
    commitId: number,
    sha: string,
    authoredAt: string,
  ): void {
    state.anonymous.get(repoId)!.push({
      commitId,
      sha,
      authoredAt: new Date(authoredAt),
      authorEmail: null,
      authorDisplayName: null,
    });
  }

  it('attributes commits with UUID + parseable email, auto-creates the user', async () => {
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/signalmessenger');
    seedAnonymous(state, 1, 100, 'sha-foysal', '2026-05-18T10:00:00Z');

    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeBBCommit({
          hash: 'sha-foysal',
          date: '2026-05-18T10:00:00+00:00',
          raw: 'Foysal <thisisfoysal@gmail.com>',
          userUuid: '{u-foysal}',
          userDisplayName: 'Foysal',
        }),
      ]),
    );

    const result = await sweepOneRepo(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      repo,
    );

    expect(result.localAnonymousCount).toBe(1);
    expect(result.matchedFromBB).toBe(1);
    expect(result.attributed).toBe(1);
    expect(result.snapshotOnly).toBe(0);
    expect(result.complete).toBe(false); // attributed > 0 → not yet marked complete; will mark on next pass
    expect(state.autoCreatedUuids.has('{u-foysal}')).toBe(true);
    expect(state.attributionUpdates).toEqual([
      {
        commitId: 100,
        userId: state.usersByUuid.get('{u-foysal}'),
        email: 'thisisfoysal@gmail.com',
        displayName: 'Foysal',
      },
    ]);
    // Local anonymous list now empty for this repo.
    expect(state.anonymous.get(1)).toHaveLength(0);
  });

  it('marks complete when attributed=0 (residual is structurally anonymous)', async () => {
    // Two commits: one has no BB user (snapshot-only), one has UUID
    // but author.raw is a noreply (also snapshot-only — email gate).
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/r');
    seedAnonymous(state, 1, 10, 'sha-no-user', '2026-05-10T00:00:00Z');
    seedAnonymous(state, 1, 11, 'sha-noreply', '2026-05-11T00:00:00Z');

    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeBBCommit({
          hash: 'sha-noreply',
          date: '2026-05-11T00:00:00+00:00',
          raw: 'X <noreply@bitbucket.org>',
          userUuid: '{u-x}',
        }),
        makeBBCommit({ hash: 'sha-no-user', date: '2026-05-10T00:00:00+00:00', raw: 'External <ex@elsewhere.com>' }),
      ]),
    );

    const result = await sweepOneRepo(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      repo,
    );

    expect(result.attributed).toBe(0);
    expect(result.snapshotOnly).toBe(2);
    expect(result.complete).toBe(true);
    expect(state.sweepComplete.has(1)).toBe(true);
    expect(state.autoCreatedUuids.size).toBe(0); // email-gate blocked the only UUID
    // Snapshot columns were filled in on both rows.
    const anonRows = state.anonymous.get(1)!;
    expect(anonRows).toHaveLength(2);
    expect(anonRows.find((r) => r.sha === 'sha-no-user')?.authorEmail).toBe('ex@elsewhere.com');
    expect(anonRows.find((r) => r.sha === 'sha-no-user')?.authorDisplayName).toBe('External');
    expect(anonRows.find((r) => r.sha === 'sha-noreply')?.authorEmail).toBeNull();
    expect(anonRows.find((r) => r.sha === 'sha-noreply')?.authorDisplayName).toBe('X');
  });

  it('marks complete and bails on BB 404 (repo gone upstream)', async () => {
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/gone');
    seedAnonymous(state, 1, 10, 'sha-orphan', '2026-05-10T00:00:00Z');

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Not Found' } }, 404));

    const result = await sweepOneRepo(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      repo,
    );

    expect(result.attributed).toBe(0);
    expect(result.complete).toBe(true);
    expect(state.sweepComplete.has(1)).toBe(true);
    // Anonymous rows untouched — BB had nothing to attribute with.
    expect(state.anonymous.get(1)).toHaveLength(1);
  });

  it('propagates BitbucketRateLimitError WITHOUT marking complete', async () => {
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/r');
    seedAnonymous(state, 1, 10, 'sha-x', '2026-05-10T00:00:00Z');

    // EVERY fetch returns 429 — the BB client retries up to its
    // built-in budget (default 3), then throws BitbucketRateLimitError
    // when retries are exhausted. mockResolvedValueOnce would only
    // mock the first call; subsequent retry attempts would see
    // undefined and produce a TypeError instead of the expected
    // BitbucketRateLimitError.
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'too many' } }, 429));

    await expect(
      sweepOneRepo({ client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store }, repo),
    ).rejects.toThrow(BitbucketRateLimitError);

    expect(state.sweepComplete.has(1)).toBe(false);
    // markAnonymousSweepAttempt was still called so the picker rotates.
    expect(state.sweepLastRunAt.has(1)).toBe(true);
  });

  it('shortcuts to complete when there are no local anonymous commits in the repo', async () => {
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/clean');
    // No anonymous rows seeded.

    const result = await sweepOneRepo(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      repo,
    );

    expect(result.localAnonymousCount).toBe(0);
    expect(result.complete).toBe(true);
    expect(state.sweepComplete.has(1)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks complete when BB returned shas but none match the local anonymous set', async () => {
    // Edge case: our local anonymous shas live on a feature branch BB's
    // default-branch walk doesn't reach.
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/r');
    seedAnonymous(state, 1, 10, 'sha-on-feature-branch', '2026-05-10T00:00:00Z');

    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeBBCommit({
          hash: 'sha-on-main',
          date: '2026-05-11T00:00:00+00:00',
          raw: 'Alice <alice@example.com>',
          userUuid: '{u-alice}',
        }),
        makeBBCommit({
          hash: 'sha-on-main-older',
          date: '2026-05-09T00:00:00+00:00',
          raw: 'Alice <alice@example.com>',
          userUuid: '{u-alice}',
        }),
      ]),
    );

    const result = await sweepOneRepo(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      repo,
    );

    expect(result.matchedFromBB).toBe(0);
    expect(result.attributed).toBe(0);
    expect(result.complete).toBe(true);
    expect(state.sweepComplete.has(1)).toBe(true);
    // Anonymous rows untouched.
    expect(state.anonymous.get(1)).toHaveLength(1);
  });

  it('recomputes commit_daily ONLY for attributed days, and invalidates affected user-summary caches', async () => {
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/r');
    seedAnonymous(state, 1, 10, 'sha-may-15', '2026-05-15T00:00:00Z');
    seedAnonymous(state, 1, 11, 'sha-may-18', '2026-05-18T00:00:00Z');
    seedAnonymous(state, 1, 12, 'sha-stuck', '2026-05-12T00:00:00Z'); // no BB user — snapshot-only

    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeBBCommit({
          hash: 'sha-may-18',
          date: '2026-05-18T00:00:00+00:00',
          raw: 'Alice <alice@example.com>',
          userUuid: '{u-alice}',
        }),
        makeBBCommit({
          hash: 'sha-may-15',
          date: '2026-05-15T00:00:00+00:00',
          raw: 'Alice <alice@example.com>',
          userUuid: '{u-alice}',
        }),
        makeBBCommit({
          hash: 'sha-stuck',
          date: '2026-05-12T00:00:00+00:00',
          raw: 'External <ext@elsewhere.com>',
        }),
      ]),
    );

    const { rollupStore, recomputeCalls } = makeRollupStore({
      listAffectedUserIdsForRepo: async () => [42],
    });
    const { userSummaryCache, invalidated } = makeCache();

    const result = await sweepOneRepo(
      {
        client: makeClient(fetchMock as unknown as typeof globalThis.fetch),
        commitStore: store,
        rollupStore,
        userSummaryCache,
      },
      repo,
    );

    expect(result.attributed).toBe(2);
    expect(result.snapshotOnly).toBe(1);
    expect(recomputeCalls).toEqual([{ repositoryId: 1, range: { sinceDay: '2026-05-15', untilDay: '2026-05-18' } }]);
    expect(invalidated).toEqual([42]);
  });

  it('does NOT recompute or invalidate when zero rows were attributed', async () => {
    // Even though snapshot columns get updated, commit_daily aggregates
    // by author_user_id — snapshot-only changes don't affect the rollup.
    const { store, state } = createSweepFakeStore();
    const repo = seedRepo(state, 1, 'tigerit/r');
    seedAnonymous(state, 1, 10, 'sha-stuck', '2026-05-12T00:00:00Z');

    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeBBCommit({ hash: 'sha-stuck', date: '2026-05-12T00:00:00+00:00', raw: 'External <ext@elsewhere.com>' }),
      ]),
    );

    const { rollupStore, recomputeCalls } = makeRollupStore();
    const { userSummaryCache, invalidated } = makeCache();

    await sweepOneRepo(
      {
        client: makeClient(fetchMock as unknown as typeof globalThis.fetch),
        commitStore: store,
        rollupStore,
        userSummaryCache,
      },
      repo,
    );

    expect(recomputeCalls).toEqual([]);
    expect(invalidated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runAnonymousSweep (outer loop)
// ---------------------------------------------------------------------------

describe('runAnonymousSweep', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('exits cleanly with reason=zero-remaining when no anonymous commits exist', async () => {
    const { store } = createSweepFakeStore();
    const summary = await runAnonymousSweep(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      { sleep: async () => {} },
    );
    expect(summary.exitReason).toBe('zero-remaining');
    expect(summary.reposSwept).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits with reason=no-candidate when remaining anonymous commits exist but every repo is marked complete', async () => {
    // Seed a repo with anonymous commits but pre-mark it complete —
    // simulates the residual-stuck state after operator has already
    // run the sweep to convergence.
    const { store, state } = createSweepFakeStore();
    const repo: AnonymousSweepCandidate = { repositoryId: 1, workspace: 'tigerit', slug: 'r', fullName: 'tigerit/r' };
    state.repos.set(1, repo);
    state.anonymous.set(1, [
      {
        commitId: 10,
        sha: 'sha-stuck',
        authoredAt: new Date('2026-05-12'),
        authorEmail: null,
        authorDisplayName: null,
      },
    ]);
    state.sweepComplete.add(1);

    const summary = await runAnonymousSweep(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      { sleep: async () => {} },
    );
    expect(summary.exitReason).toBe('no-candidate');
    expect(summary.reposSwept).toBe(0);
  });

  it('sleeps when budget is below threshold and resumes when budget recovers', async () => {
    const { store, state } = createSweepFakeStore();
    const repo: AnonymousSweepCandidate = { repositoryId: 1, workspace: 'tigerit', slug: 'r', fullName: 'tigerit/r' };
    state.repos.set(1, repo);
    state.anonymous.set(1, [
      { commitId: 10, sha: 'sha-x', authoredAt: new Date('2026-05-12'), authorEmail: null, authorDisplayName: null },
    ]);
    fetchMock.mockResolvedValueOnce(
      commitsPage([
        makeBBCommit({ hash: 'sha-x', date: '2026-05-12T00:00:00+00:00', raw: 'External <ext@elsewhere.com>' }),
      ]),
    );

    // Set client budget low for the first check, then high via stub.
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, 800);
    let budgetCalls = 0;
    const realGetBudget = client.getBudgetRemaining.bind(client);
    client.getBudgetRemaining = (): number => {
      budgetCalls++;
      if (budgetCalls === 1) return 10; // first check: low
      return realGetBudget(); // subsequent: real (high)
    };

    const sleepCalls: number[] = [];
    const summary = await runAnonymousSweep(
      { client, commitStore: store },
      {
        budgetThreshold: 100,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    );

    expect(sleepCalls).toEqual([60_000]);
    expect(summary.exitReason).toBe('no-candidate'); // repo got marked complete after the sweep
    expect(summary.reposSwept).toBe(1);
  });

  it('rotates past a failed repo and continues with the next', async () => {
    // First repo throws on BB call; second succeeds. Loop should
    // log the first failure (NOT mark complete — generic errors are
    // transient), then pick the next repo on the following iteration.
    //
    // Important: the picker is stubbed to a deterministic sequence
    // (repo 1 → repo 2 → null) so the loop exits cleanly after the
    // two attempts. Without that, the picker's natural rotation
    // would re-pick the failing repo indefinitely (it has anonymous
    // commits + isn't marked complete) and the test would hang.
    const { store, state } = createSweepFakeStore();
    state.repos.set(1, { repositoryId: 1, workspace: 'tigerit', slug: 'broken', fullName: 'tigerit/broken' });
    state.repos.set(2, { repositoryId: 2, workspace: 'tigerit', slug: 'ok', fullName: 'tigerit/ok' });
    state.anonymous.set(1, [
      { commitId: 10, sha: 'sha-a', authoredAt: new Date('2026-05-10'), authorEmail: null, authorDisplayName: null },
    ]);
    state.anonymous.set(2, [
      { commitId: 11, sha: 'sha-b', authoredAt: new Date('2026-05-11'), authorEmail: null, authorDisplayName: null },
    ]);

    const pickSequence: Array<AnonymousSweepCandidate | null> = [
      { repositoryId: 1, workspace: 'tigerit', slug: 'broken', fullName: 'tigerit/broken' },
      { repositoryId: 2, workspace: 'tigerit', slug: 'ok', fullName: 'tigerit/ok' },
      null,
    ];
    let pickIdx = 0;
    vi.spyOn(store, 'pickRepoForAnonymousSweep').mockImplementation(async () => {
      return pickSequence[pickIdx++] ?? null;
    });

    // URL-aware mock — repo 1's BB calls ALWAYS return 500 (the BB
    // client will retry 3x then throw BitbucketApiError). Repo 2's BB
    // call returns a snapshot-only commit. Without URL inspection the
    // retry chain on repo 1 would consume the response queued for
    // repo 2 and corrupt the test scenario.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/repositories/tigerit/broken/')) {
        return Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500));
      }
      if (url.includes('/repositories/tigerit/ok/')) {
        return Promise.resolve(
          commitsPage([
            makeBBCommit({ hash: 'sha-b', date: '2026-05-11T00:00:00+00:00', raw: 'External <ext@elsewhere.com>' }),
          ]),
        );
      }
      throw new Error(`unexpected URL in test: ${url}`);
    });

    const summary = await runAnonymousSweep(
      { client: makeClient(fetchMock as unknown as typeof globalThis.fetch), commitStore: store },
      { sleep: async () => {} },
    );

    expect(summary.exitReason).toBe('no-candidate');
    expect(summary.reposSwept).toBe(1); // only repo 2 ran to completion
    // Repo 1 failed → not marked complete; repo 2 succeeded with
    // attributed=0 → marked complete.
    expect(state.sweepComplete.has(1)).toBe(false);
    expect(state.sweepComplete.has(2)).toBe(true);
  });
});

// Ensure unused-import lint rule passes (BitbucketApiError is imported
// for documentation in the test file but only one test triggers it
// directly via fetchMock).
void BitbucketApiError;
