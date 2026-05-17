import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useActivityPageStore, ACTIVITY_PAGE_SIZE } from '../src/stores/activity-page';
import type { ActivityEntry } from '../src/api/client';

vi.mock('../src/api/client', () => ({
  api: { activity: vi.fn(), activityCount: vi.fn() },
}));

import { api } from '../src/api/client';

function makeCommit(sha: string, occurredAt: string): ActivityEntry {
  return {
    kind: 'commit',
    sha,
    message: 'feat: thing',
    additions: 1,
    deletions: 1,
    filesChanged: 1,
    isMerge: false,
    diffStatsUnavailable: false,
    repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
    author: { userId: 1, displayName: 'Alice', bitbucketUuid: '{u1}' },
    occurredAt,
  };
}

function pageOf(n: number, startTime: number): ActivityEntry[] {
  return Array.from({ length: n }, (_, i) =>
    makeCommit(`sha-${startTime}-${i}`, new Date(startTime - i * 1000).toISOString()),
  );
}

function mockCount(total: number): void {
  vi.mocked(api.activityCount).mockResolvedValueOnce({ total });
}

describe('activity-page store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('load() fetches page 1 with offset=0 and records the total count', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValueOnce(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);

    await store.load({});

    expect(api.activity).toHaveBeenCalledWith(expect.objectContaining({ limit: ACTIVITY_PAGE_SIZE, offset: 0 }));
    expect(api.activityCount).toHaveBeenCalledWith({});
    expect(store.entries).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(store.page).toBe(1);
    expect(store.total).toBe(550);
    expect(store.pageCount).toBe(6);
  });

  it('canPrev/canNext/canFirst/canLast reflect page position', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValue(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);

    await store.load({});

    expect(store.canFirst).toBe(false);
    expect(store.canPrev).toBe(false);
    expect(store.canNext).toBe(true);
    expect(store.canLast).toBe(true);
  });

  it('next() bumps page and fetches the next offset', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValue(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);
    await store.load({});

    mockCount(550);
    await store.next({});

    expect(store.page).toBe(2);
    expect(api.activity).toHaveBeenLastCalledWith(expect.objectContaining({ offset: ACTIVITY_PAGE_SIZE }));
  });

  it('prev() decrements page and fetches the previous offset', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValue(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);
    await store.load({});
    mockCount(550);
    await store.next({});

    mockCount(550);
    await store.prev({});

    expect(store.page).toBe(1);
    expect(api.activity).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('last() jumps to the final page and uses the matching offset', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValue(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);
    await store.load({});

    mockCount(550);
    await store.last({});

    expect(store.page).toBe(6);
    // (6 - 1) * 100 = 500
    expect(api.activity).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500 }));
  });

  it('first() jumps back to page 1', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValue(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);
    await store.load({});
    mockCount(550);
    await store.last({});

    mockCount(550);
    await store.first({});

    expect(store.page).toBe(1);
    expect(api.activity).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }));
  });

  it('next() / prev() are no-ops at the edges', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValueOnce(pageOf(7, Date.UTC(2026, 4, 12)));
    mockCount(7);
    await store.load({});

    vi.mocked(api.activity).mockClear();
    vi.mocked(api.activityCount).mockClear();
    await store.prev({});
    await store.next({});

    expect(api.activity).not.toHaveBeenCalled();
    expect(api.activityCount).not.toHaveBeenCalled();
    expect(store.page).toBe(1);
  });

  it('applyTickComplete() refetches page 1 with the last-used filters', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValue(pageOf(ACTIVITY_PAGE_SIZE, Date.UTC(2026, 4, 12)));
    mockCount(550);
    await store.load({ actor: 7, project: 'COMM' });
    mockCount(550);
    await store.next({ actor: 7, project: 'COMM' });
    expect(store.page).toBe(2);

    mockCount(550);
    await store.applyTickComplete();

    expect(api.activity).toHaveBeenLastCalledWith(expect.objectContaining({ actor: 7, project: 'COMM', offset: 0 }));
    expect(store.page).toBe(1);
  });

  it('applyTickComplete() is a no-op before the first load', async () => {
    const store = useActivityPageStore();
    await store.applyTickComplete();
    expect(api.activity).not.toHaveBeenCalled();
  });

  it('forwards hashPrefix / message / after through to both endpoints', async () => {
    const store = useActivityPageStore();
    vi.mocked(api.activity).mockResolvedValueOnce([]);
    mockCount(0);

    await store.load({
      hashPrefix: 'abc123',
      message: 'widget',
      after: '2026-05-01T00:00:00.000Z',
    });

    const expected = expect.objectContaining({
      hashPrefix: 'abc123',
      message: 'widget',
      after: '2026-05-01T00:00:00.000Z',
    });
    expect(api.activity).toHaveBeenCalledWith(expected);
    expect(api.activityCount).toHaveBeenCalledWith({
      hashPrefix: 'abc123',
      message: 'widget',
      after: '2026-05-01T00:00:00.000Z',
    });
  });
});
