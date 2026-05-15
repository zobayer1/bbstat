import { describe, expect, it, vi } from 'vitest';
import { withRollupRecompute } from './rollup-hook.js';
import type { CommitSyncDeps, RepoCommitSyncResult, RepositoryHandle } from '../sync/commits.js';
import type { RollupStore } from './rollup-store.js';
import type { UserSummaryCache } from './user-summary-cache.js';

function makeCache(overrides: Partial<UserSummaryCache> = {}): UserSummaryCache {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeRepo(): RepositoryHandle {
  return {
    repositoryId: 1,
    workspace: 'tigerit',
    slug: 'r',
    fullName: 'tigerit/r',
    diffStatsEnabled: false,
    diffStatsExcludePatterns: [],
  };
}

function makeRollupStore(overrides: Partial<RollupStore> = {}): RollupStore {
  return {
    recomputeCommitDailyForRepo: vi.fn(async () => ({ rowsAffected: 1 })),
    listAffectedUserIdsForRepo: vi.fn(async () => []),
    rebuildAll: vi.fn(async () => ({ rowsAffected: 0 })),
    ...overrides,
  };
}

function makeResult(over: Partial<RepoCommitSyncResult> = {}): RepoCommitSyncResult {
  return {
    repositoryId: 1,
    fullName: 'tigerit/r',
    mode: 'delta',
    fetched: 0,
    inserted: 0,
    newCursor: null,
    hitKnownSha: false,
    hitPageCap: false,
    hitDateCap: false,
    insertedRange: null,
    diffStatsUpdated: 0,
    diffStatsFailed: 0,
    diffStatsRange: null,
    autoExcluded: null,
    ...over,
  };
}

describe('withRollupRecompute', () => {
  it('skips rollup when inserted = 0', async () => {
    const rollup = makeRollupStore();
    const inner = vi.fn(async () => makeResult());
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });
    await wrapped({} as CommitSyncDeps, makeRepo(), {});
    expect(rollup.recomputeCommitDailyForRepo).not.toHaveBeenCalled();
  });

  it('skips rollup when insertedRange is null even with inserted > 0', async () => {
    // Defense against a future bug: inserted > 0 should imply a non-null
    // range, but we still want to skip safely if it ever happens.
    const rollup = makeRollupStore();
    const inner = vi.fn(async () => makeResult({ inserted: 3, insertedRange: null }));
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });
    await wrapped({} as CommitSyncDeps, makeRepo(), {});
    expect(rollup.recomputeCommitDailyForRepo).not.toHaveBeenCalled();
  });

  it('calls recompute with the batch day range when inserts happened', async () => {
    const rollup = makeRollupStore();
    const range = { sinceDay: '2026-05-01', untilDay: '2026-05-07' };
    const inner = vi.fn(async () => makeResult({ inserted: 5, insertedRange: range }));
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });

    const result = await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(rollup.recomputeCommitDailyForRepo).toHaveBeenCalledWith(1, range);
    expect(result.inserted).toBe(5);
  });

  it('returns the inner result unchanged when rollup throws', async () => {
    const rollup = makeRollupStore({
      recomputeCommitDailyForRepo: vi.fn(async () => {
        throw new Error('rollup boom');
      }),
    });
    const inner = vi.fn(async () =>
      makeResult({ inserted: 5, insertedRange: { sinceDay: '2026-05-01', untilDay: '2026-05-07' } }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });

    const result = await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(result.inserted).toBe(5);
    expect(result.insertedRange).toEqual({ sinceDay: '2026-05-01', untilDay: '2026-05-07' });
  });

  it('invalidates user-summary cache for each affected user when cache is wired', async () => {
    const rollup = makeRollupStore({
      listAffectedUserIdsForRepo: vi.fn(async () => [3, 7, 11]),
    });
    const cache = makeCache();
    const inner = vi.fn(async () =>
      makeResult({ inserted: 5, insertedRange: { sinceDay: '2026-05-01', untilDay: '2026-05-07' } }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup, userSummaryCache: cache });

    await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(cache.invalidate).toHaveBeenCalledTimes(3);
    expect(cache.invalidate).toHaveBeenCalledWith(3);
    expect(cache.invalidate).toHaveBeenCalledWith(7);
    expect(cache.invalidate).toHaveBeenCalledWith(11);
  });

  it('skips cache invalidation when cache is absent', async () => {
    const rollup = makeRollupStore({
      listAffectedUserIdsForRepo: vi.fn(async () => [3]),
    });
    const inner = vi.fn(async () =>
      makeResult({ inserted: 5, insertedRange: { sinceDay: '2026-05-01', untilDay: '2026-05-07' } }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });

    await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(rollup.listAffectedUserIdsForRepo).not.toHaveBeenCalled();
  });

  it('swallows cache-invalidation errors and still returns the inner result', async () => {
    const rollup = makeRollupStore({
      listAffectedUserIdsForRepo: vi.fn(async () => [3]),
    });
    const cache = makeCache({
      invalidate: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    const inner = vi.fn(async () =>
      makeResult({ inserted: 5, insertedRange: { sinceDay: '2026-05-01', untilDay: '2026-05-07' } }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup, userSummaryCache: cache });

    const result = await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(result.inserted).toBe(5);
  });

  it('triggers recompute when only diff stats updated (no inserts)', async () => {
    const rollup = makeRollupStore();
    const inner = vi.fn(async () =>
      makeResult({
        inserted: 0,
        insertedRange: null,
        diffStatsUpdated: 4,
        diffStatsRange: { sinceDay: '2026-05-03', untilDay: '2026-05-06' },
      }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });

    await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(rollup.recomputeCommitDailyForRepo).toHaveBeenCalledWith(1, {
      sinceDay: '2026-05-03',
      untilDay: '2026-05-06',
    });
  });

  it('passes the union of insertedRange and diffStatsRange to recompute', async () => {
    const rollup = makeRollupStore();
    const inner = vi.fn(async () =>
      makeResult({
        inserted: 3,
        insertedRange: { sinceDay: '2026-05-05', untilDay: '2026-05-07' },
        diffStatsUpdated: 2,
        // Diff stats touched an earlier day window than the inserts.
        diffStatsRange: { sinceDay: '2026-05-01', untilDay: '2026-05-04' },
      }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });

    await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(rollup.recomputeCommitDailyForRepo).toHaveBeenCalledWith(1, {
      sinceDay: '2026-05-01',
      untilDay: '2026-05-07',
    });
  });

  it('skips rollup when neither inserts nor diff stats happened', async () => {
    const rollup = makeRollupStore();
    const inner = vi.fn(async () =>
      makeResult({
        inserted: 0,
        insertedRange: null,
        diffStatsUpdated: 0,
        diffStatsRange: null,
      }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup });

    await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(rollup.recomputeCommitDailyForRepo).not.toHaveBeenCalled();
  });

  it('recomputes rollup before invalidating cache (ordering)', async () => {
    const calls: string[] = [];
    const rollup = makeRollupStore({
      recomputeCommitDailyForRepo: vi.fn(async () => {
        calls.push('recompute');
        return { rowsAffected: 1 };
      }),
      listAffectedUserIdsForRepo: vi.fn(async () => {
        calls.push('list-users');
        return [3];
      }),
    });
    const cache = makeCache({
      invalidate: vi.fn(async () => {
        calls.push('invalidate');
      }),
    });
    const inner = vi.fn(async () =>
      makeResult({ inserted: 5, insertedRange: { sinceDay: '2026-05-01', untilDay: '2026-05-07' } }),
    );
    const wrapped = withRollupRecompute(inner, { rollupStore: rollup, userSummaryCache: cache });

    await wrapped({} as CommitSyncDeps, makeRepo(), {});

    expect(calls).toEqual(['recompute', 'list-users', 'invalidate']);
  });
});
