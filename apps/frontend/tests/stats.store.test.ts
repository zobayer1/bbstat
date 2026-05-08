import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useStatsStore } from '../src/stores/stats';

vi.mock('../src/api/client', () => ({
  api: {
    statsOverview: vi.fn(),
  },
}));

import { api } from '../src/api/client';

describe('stats store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('starts empty, not loading, no error', () => {
    const store = useStatsStore();
    expect(store.overview).toBeNull();
    expect(store.lastSyncedAt).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it('fetchOverview() populates overview and stamps lastSyncedAt on success', async () => {
    vi.mocked(api.statsOverview).mockResolvedValueOnce({
      users: 49,
      repositories: 3,
      projects: 1,
    });
    const store = useStatsStore();

    await store.fetchOverview();

    expect(store.overview).toEqual({ users: 49, repositories: 3, projects: 1 });
    expect(store.lastSyncedAt).not.toBeNull();
    expect(store.error).toBeNull();
    expect(store.loading).toBe(false);
  });

  it('fetchOverview() captures the error and leaves stale overview in place', async () => {
    const store = useStatsStore();
    // Seed a "previously fetched" overview to confirm we don't wipe it on error.
    vi.mocked(api.statsOverview).mockResolvedValueOnce({
      users: 49,
      repositories: 3,
      projects: 1,
    });
    await store.fetchOverview();

    vi.mocked(api.statsOverview).mockRejectedValueOnce(new Error('Request failed: 503'));
    await store.fetchOverview();

    expect(store.error).toBe('Request failed: 503');
    expect(store.overview).toEqual({ users: 49, repositories: 3, projects: 1 });
    expect(store.loading).toBe(false);
  });

  it('clear() resets everything', () => {
    const store = useStatsStore();
    store.$patch({ overview: { users: 1, repositories: 1, projects: 1 } });
    store.clear();
    expect(store.overview).toBeNull();
    expect(store.lastSyncedAt).toBeNull();
    expect(store.error).toBeNull();
  });
});
