import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useActivityStore, MAX_ENTRIES_PER_FILTER } from '../src/stores/activity';
import type { ActivityEntry } from '../src/api/client';

vi.mock('../src/api/client', () => ({
  api: { activity: vi.fn() },
}));

import { api } from '../src/api/client';

function makeCommit(over: Partial<Extract<ActivityEntry, { kind: 'commit' }>> = {}): ActivityEntry {
  return {
    kind: 'commit',
    sha: 'sha-1',
    message: 'feat: thing',
    additions: 10,
    deletions: 2,
    filesChanged: 1,
    isMerge: false,
    diffStatsUnavailable: false,
    repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
    author: { userId: 1, displayName: 'Alice', bitbucketUuid: '{u1}' },
    occurredAt: '2026-05-12T18:00:00.000Z',
    ...over,
  };
}

function makePr(over: Partial<Extract<ActivityEntry, { kind: 'pr' }>> = {}): ActivityEntry {
  return {
    kind: 'pr',
    prId: 42,
    title: 'feat: shiny',
    state: 'OPEN',
    sourceBranch: 'feat',
    destinationBranch: 'main',
    repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
    author: null,
    occurredAt: '2026-05-12T14:00:00.000Z',
    ...over,
  };
}

describe('activity store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('keys entries by filter triple — actor filter does not share with org-wide view', async () => {
    const store = useActivityStore();
    vi.mocked(api.activity).mockResolvedValueOnce([makeCommit()]);
    await store.load({ actor: 7 });
    vi.mocked(api.activity).mockResolvedValueOnce([makePr()]);
    await store.load({});

    const keyActor = store.keyFor({ actor: 7 });
    const keyAll = store.keyFor({});
    expect(store.byKey[keyActor]).toHaveLength(1);
    expect(store.byKey[keyAll]).toHaveLength(1);
    // Different filter sets → different cache slots.
    expect(keyActor).not.toBe(keyAll);
  });

  it('flags `exhausted` when the page comes back shorter than PAGE_SIZE', async () => {
    const store = useActivityStore();
    vi.mocked(api.activity).mockResolvedValueOnce([makeCommit()]);
    await store.load({});

    expect(store.exhausted[store.keyFor({})]).toBe(true);
  });

  it('loadMore passes the last entry occurredAt as `before` and appends', async () => {
    const store = useActivityStore();
    // First page — full PAGE_SIZE so exhausted stays false.
    const page1 = Array.from({ length: 50 }, (_, i) =>
      makeCommit({ sha: `sha-${i}`, occurredAt: '2026-05-12T18:00:00.000Z' }),
    );
    vi.mocked(api.activity).mockResolvedValueOnce(page1);
    await store.load({});

    vi.mocked(api.activity).mockResolvedValueOnce([makePr({ prId: 99, occurredAt: '2026-05-10T00:00:00.000Z' })]);
    await store.loadMore({});

    const key = store.keyFor({});
    expect(store.byKey[key]).toHaveLength(51);
    expect(api.activity).toHaveBeenLastCalledWith({ before: '2026-05-12T18:00:00.000Z', limit: 50 });
    // Final page < PAGE_SIZE → exhausted now.
    expect(store.exhausted[key]).toBe(true);
  });

  it('loadMore is a no-op once exhausted', async () => {
    const store = useActivityStore();
    vi.mocked(api.activity).mockResolvedValueOnce([makeCommit()]);
    await store.load({});
    vi.clearAllMocks();
    await store.loadMore({});
    expect(api.activity).not.toHaveBeenCalled();
  });

  it('captures fetch errors per filter key without dropping prior data', async () => {
    const store = useActivityStore();
    vi.mocked(api.activity).mockResolvedValueOnce([makeCommit()]);
    await store.load({});
    vi.mocked(api.activity).mockRejectedValueOnce(new Error('boom'));
    await store.load({ actor: 9 });

    const keyAll = store.keyFor({});
    const keyActor = store.keyFor({ actor: 9 });
    expect(store.byKey[keyAll]).toHaveLength(1);
    expect(store.error[keyActor]).toBe('boom');
    expect(store.byKey[keyActor]).toBeUndefined();
  });

  it('loadMore is a no-op once entries hit MAX_ENTRIES_PER_FILTER', async () => {
    const store = useActivityStore();
    // Pre-seed the cache at the cap. loadMore should not call the API.
    const fullPage: ActivityEntry[] = Array.from({ length: MAX_ENTRIES_PER_FILTER }, (_, i) =>
      makeCommit({ sha: `sha-${i}` }),
    );
    store.byKey[store.keyFor({})] = fullPage;

    await store.loadMore({});

    expect(api.activity).not.toHaveBeenCalled();
    expect(store.byKey[store.keyFor({})]).toHaveLength(MAX_ENTRIES_PER_FILTER);
  });

  it('clear wipes every key', async () => {
    const store = useActivityStore();
    vi.mocked(api.activity).mockResolvedValueOnce([makeCommit()]);
    await store.load({});
    store.clear();
    expect(store.byKey).toEqual({});
    expect(store.exhausted).toEqual({});
  });
});
