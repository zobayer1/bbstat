import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUserSummaryStore } from '../src/stores/userSummary';
import { liveBus } from '../src/lib/live';

vi.mock('../src/api/client', () => ({
  api: { userSummary: vi.fn() },
}));

import { api } from '../src/api/client';
import type { UserSummary } from '../src/api/client';

const sampleSummary: UserSummary = {
  user: { id: 7, bitbucketUuid: '{u7}', displayName: 'Alice' },
  totals: {
    commits7d: 12,
    commits30d: 40,
    commitsAllTime: 200,
    additions7d: 0,
    deletions7d: 0,
    additions30d: 0,
    deletions30d: 0,
    repositoriesAllTime: 4,
  },
  dailyCommits: [{ date: '2026-05-12', commits: 3 }],
  topRepos: [
    {
      workspace: 'tigerit',
      slug: 'r1',
      fullName: 'tigerit/r1',
      project: 'COMM',
      commits: 8,
      syncStatus: 'ok',
      diffStatsEnabled: false,
      additions30d: 0,
      deletions30d: 0,
      filesChanged30d: 0,
    },
  ],
};

describe('userSummary store', () => {
  beforeEach(() => {
    // Reset the live bus first so prior tests' handler registrations
    // don't pile up — each store setup registers fresh handlers on
    // the global bus, and without reset the global state leaks.
    liveBus.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('starts empty', () => {
    const store = useUserSummaryStore();
    expect(store.byUserId).toEqual({});
    expect(store.loading).toEqual({});
    expect(store.error).toEqual({});
  });

  it('fetch(id) populates byUserId[id] and toggles loading', async () => {
    vi.mocked(api.userSummary).mockResolvedValueOnce(sampleSummary);
    const store = useUserSummaryStore();

    const p = store.fetch(7);
    expect(store.loading[7]).toBe(true);
    await p;

    expect(store.byUserId[7]).toEqual(sampleSummary);
    expect(store.loading[7]).toBe(false);
    expect(store.error[7]).toBeNull();
    expect(api.userSummary).toHaveBeenCalledWith(7);
  });

  it('records the error message when the API rejects', async () => {
    vi.mocked(api.userSummary).mockRejectedValueOnce(new Error('boom'));
    const store = useUserSummaryStore();

    await store.fetch(7);

    expect(store.byUserId[7]).toBeUndefined();
    expect(store.error[7]).toBe('boom');
    expect(store.loading[7]).toBe(false);
  });

  it('applyTickComplete re-fetches every currently-cached user', async () => {
    vi.mocked(api.userSummary).mockResolvedValue(sampleSummary);
    const store = useUserSummaryStore();
    await store.fetch(7);
    await store.fetch(13);
    vi.mocked(api.userSummary).mockClear();

    await store.applyTickComplete();

    expect(api.userSummary).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(api.userSummary)
        .mock.calls.map((c) => c[0])
        .sort((a, b) => a - b),
    ).toEqual([7, 13]);
  });

  it('emits tick.commits.complete on the live bus → store re-fetches every cached user', async () => {
    vi.mocked(api.userSummary).mockResolvedValue(sampleSummary);
    const store = useUserSummaryStore();
    await store.fetch(7);
    vi.mocked(api.userSummary).mockClear();

    liveBus.emit('tick.commits.complete', {
      trigger: 'cron',
      startedAt: '',
      finishedAt: '',
      attempted: 0,
      deferred: 0,
      errors: 0,
      totalCommitsInserted: 0,
      budgetRemainingAtEnd: 1000,
      stoppedEarly: false,
      deepenStoppedReason: null,
      isMergeBackfillStoppedReason: null,
      diffStatsBackfillStopReason: null,
      diffStatsBackfillTotalUpdated: 0,
      diffStatsAutoOptIn: null,
    });
    // applyTickComplete is fired off as a void-promise inside the
    // bus handler; flush pending microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(api.userSummary).toHaveBeenCalledWith(7);
  });

  it('polling fallback (emitFallback) also triggers a re-fetch', async () => {
    vi.mocked(api.userSummary).mockResolvedValue(sampleSummary);
    const store = useUserSummaryStore();
    await store.fetch(7);
    vi.mocked(api.userSummary).mockClear();

    liveBus.emitFallback();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.userSummary).toHaveBeenCalledWith(7);
  });
});
