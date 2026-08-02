import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRepoActivityStore } from '../src/stores/repoActivity';

vi.mock('../src/api/client', () => ({
  api: { repositoryActivity: vi.fn() },
}));

import { api } from '../src/api/client';
import type { RepoActivity } from '../src/api/client';

const sample: RepoActivity = {
  repository: {
    workspace: 'acme',
    slug: 'r1',
    fullName: 'acme/r1',
    project: 'COMM',
    syncStatus: 'ok',
    archived: false,
  },
  dailyCommits: [{ date: '2026-05-12', commits: 4, additions: 0, deletions: 0 }],
  diffStats: { additions7d: 0, deletions7d: 0, additions30d: 0, deletions30d: 0 },
  contributors: [
    {
      entityKind: 'user',
      entityId: 1,
      attachedUserIds: [1],
      bitbucketUuid: '{u1}',
      displayName: 'Alice',
      commits: 4,
      last30Days: [0, 1, 0, 3],
      additions30d: 0,
      deletions30d: 0,
    },
  ],
};

describe('repoActivity store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('starts empty', () => {
    const store = useRepoActivityStore();
    expect(store.byFullName).toEqual({});
  });

  it('keyFor() composes "<workspace>/<slug>"', () => {
    const store = useRepoActivityStore();
    expect(store.keyFor('acme', 'r1')).toBe('acme/r1');
  });

  it('fetch(workspace, slug) populates byFullName under the composite key', async () => {
    vi.mocked(api.repositoryActivity).mockResolvedValueOnce(sample);
    const store = useRepoActivityStore();

    await store.fetch('acme', 'r1');

    expect(store.byFullName['acme/r1']).toEqual(sample);
    expect(api.repositoryActivity).toHaveBeenCalledWith('acme', 'r1');
  });

  it('records error on API rejection', async () => {
    vi.mocked(api.repositoryActivity).mockRejectedValueOnce(new Error('down'));
    const store = useRepoActivityStore();

    await store.fetch('acme', 'r1');

    expect(store.error['acme/r1']).toBe('down');
  });
});
