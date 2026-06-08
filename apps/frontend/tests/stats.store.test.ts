import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useStatsStore } from '../src/stores/stats';

vi.mock('../src/api/client', () => ({
  api: {
    statsOverview: vi.fn(),
    topContributors: vi.fn(),
    listRepositories: vi.fn(),
  },
}));

import { api } from '../src/api/client';

const sampleOverview = {
  contributors: 49,
  repositories: 3,
  projects: 1,
  totalCommits: 1234,
  commitsLast7Days: 87,
  commitsLast30Days: 312,
};
const sampleContributors = [
  {
    entityKind: 'user' as const,
    entityId: 1,
    attachedUserIds: [1],
    bitbucketUuid: '{u1}',
    displayName: 'Alice',
    commits: 42,
    last30Days: new Array(30).fill(0),
    additionsWindow: 0,
    deletionsWindow: 0,
    reposWindow: 1,
    momentum: null,
    consistency90d: null,
  },
  {
    entityKind: 'person' as const,
    entityId: 9,
    attachedUserIds: [2, 7],
    bitbucketUuid: '{u2}',
    displayName: 'Bob (merged)',
    commits: 17,
    last30Days: new Array(30).fill(0),
    additionsWindow: 0,
    deletionsWindow: 0,
    reposWindow: 1,
    momentum: null,
    consistency90d: null,
  },
];
const sampleRepositories = [
  {
    workspace: 'tigerit',
    slug: 'r1',
    fullName: 'tigerit/r1',
    project: 'COMM',
    commits30d: 30,
    contributors30d: 4,
    additions30d: 0,
    deletions30d: 0,
    lastCommitAt: '2026-05-12T00:00:00.000Z',
    syncStatus: 'ok' as const,
    archived: false,
  },
];

describe('stats store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.topContributors).mockResolvedValue([]);
    vi.mocked(api.listRepositories).mockResolvedValue([]);
  });

  it('starts empty, not loading, no error', () => {
    const store = useStatsStore();
    expect(store.overview).toBeNull();
    expect(store.topContributors).toEqual([]);
    expect(store.repositories).toEqual([]);
    expect(store.contributorsWindow).toBe('7d');
    expect(store.lastSyncedAt).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it('fetchOverview() hydrates overview + topContributors + repositories and stamps lastSyncedAt', async () => {
    vi.mocked(api.statsOverview).mockResolvedValueOnce(sampleOverview);
    vi.mocked(api.topContributors).mockResolvedValueOnce(sampleContributors);
    vi.mocked(api.listRepositories).mockResolvedValueOnce(sampleRepositories);
    const store = useStatsStore();

    await store.fetchOverview();

    expect(store.overview).toEqual(sampleOverview);
    expect(store.topContributors).toEqual(sampleContributors);
    expect(store.repositories).toEqual(sampleRepositories);
    expect(api.topContributors).toHaveBeenCalledWith('7d');
    expect(api.listRepositories).toHaveBeenCalledTimes(1);
    expect(store.lastSyncedAt).not.toBeNull();
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it('fetchOverview() captures the error and leaves stale state in place', async () => {
    vi.mocked(api.statsOverview).mockResolvedValueOnce(sampleOverview);
    vi.mocked(api.topContributors).mockResolvedValueOnce(sampleContributors);
    vi.mocked(api.listRepositories).mockResolvedValueOnce(sampleRepositories);
    const store = useStatsStore();
    await store.fetchOverview();

    vi.mocked(api.statsOverview).mockRejectedValueOnce(new Error('Request failed: 503'));
    await store.fetchOverview();

    expect(store.error).toBe('Request failed: 503');
    // Stale state preserved (offline-first)
    expect(store.overview).toEqual(sampleOverview);
    expect(store.topContributors).toEqual(sampleContributors);
    expect(store.repositories).toEqual(sampleRepositories);
    expect(store.loading).toBe(false);
  });

  it('setContributorsWindow() refetches with the new window', async () => {
    vi.mocked(api.topContributors).mockResolvedValueOnce([
      {
        entityKind: 'user' as const,
        entityId: 9,
        attachedUserIds: [9],
        bitbucketUuid: '{u9}',
        displayName: 'Carol',
        commits: 200,
        last30Days: new Array(30).fill(0),
        additionsWindow: 0,
        deletionsWindow: 0,
        reposWindow: 1,
        momentum: null,
        consistency90d: null,
      },
    ]);
    const store = useStatsStore();

    await store.setContributorsWindow('30d');

    expect(store.contributorsWindow).toBe('30d');
    expect(store.topContributors[0]?.displayName).toBe('Carol');
    expect(api.topContributors).toHaveBeenCalledWith('30d');
  });

  it('setContributorsWindow() with the same value is a no-op (no extra fetch)', async () => {
    const store = useStatsStore();

    await store.setContributorsWindow('7d');

    expect(api.topContributors).not.toHaveBeenCalled();
  });

  it('clear() resets everything', () => {
    const store = useStatsStore();
    store.$patch({ overview: sampleOverview, topContributors: sampleContributors, repositories: sampleRepositories });
    store.clear();
    expect(store.overview).toBeNull();
    expect(store.topContributors).toEqual([]);
    expect(store.repositories).toEqual([]);
    expect(store.lastSyncedAt).toBeNull();
    expect(store.error).toBeNull();
  });
});
