import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useProjectStatsStore } from '../src/stores/projectStats';

vi.mock('../src/api/client', () => ({
  api: { projectStats: vi.fn() },
}));

import { api } from '../src/api/client';
import type { ProjectStats } from '../src/api/client';

const sample: ProjectStats = {
  project: 'COMM',
  totals: { commits7d: 250, commits30d: 850, contributorCount7d: 11, repositoryCount: 28 },
  dailyCommits: [{ date: '2026-05-12', commits: 10 }],
  topContributors: [
    {
      userId: 1,
      bitbucketUuid: '{u1}',
      displayName: 'Alice',
      commits: 42,
      last30Days: new Array(30).fill(0),
      additionsWindow: 0,
      deletionsWindow: 0,
      reposWindow: 1,
      additions30d: 0,
      deletions30d: 0,
    },
  ],
  repositories: [
    {
      workspace: 'tigerit',
      slug: 'r1',
      fullName: 'tigerit/r1',
      commits30d: 30,
      contributors30d: 3,
      lastCommitAt: '2026-05-12T00:00:00.000Z',
      syncStatus: 'ok',
    },
  ],
};

describe('projectStats store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('starts empty', () => {
    const store = useProjectStatsStore();
    expect(store.byProjectKey).toEqual({});
  });

  it('fetch(key) populates byProjectKey[key]', async () => {
    vi.mocked(api.projectStats).mockResolvedValueOnce(sample);
    const store = useProjectStatsStore();

    await store.fetch('COMM');

    expect(store.byProjectKey['COMM']).toEqual(sample);
    expect(store.loading['COMM']).toBe(false);
    expect(api.projectStats).toHaveBeenCalledWith('COMM');
  });

  it('records error on API rejection', async () => {
    vi.mocked(api.projectStats).mockRejectedValueOnce(new Error('nope'));
    const store = useProjectStatsStore();

    await store.fetch('COMM');

    expect(store.error['COMM']).toBe('nope');
  });
});
