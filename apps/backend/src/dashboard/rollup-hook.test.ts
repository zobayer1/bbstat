import { describe, expect, it, vi } from 'vitest';
import { withRollupRecompute } from './rollup-hook.js';
import type { CommitSyncDeps, RepoCommitSyncResult, RepositoryHandle } from '../sync/commits.js';
import type { RollupStore } from './rollup-store.js';

function makeRepo(): RepositoryHandle {
  return { repositoryId: 1, workspace: 'tigerit', slug: 'r', fullName: 'tigerit/r' };
}

function makeRollupStore(overrides: Partial<RollupStore> = {}): RollupStore {
  return {
    recomputeCommitDailyForRepo: vi.fn(async () => ({ rowsAffected: 1 })),
    listAffectedUserIdsForRepo: vi.fn(async () => []),
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
});
