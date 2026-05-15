import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUserSummaryStore } from '../src/stores/userSummary';

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
});
