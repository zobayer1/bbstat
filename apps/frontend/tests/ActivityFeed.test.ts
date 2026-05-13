import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import ActivityFeed from '../src/components/ActivityFeed.vue';
import type { ActivityEntry } from '../src/api/client';

// jsdom doesn't ship IntersectionObserver — the component constructs one in
// onMounted, so we stub it to avoid a ReferenceError. The stub doesn't need
// to fire callbacks; loadMore behavior is covered by the store tests.
class IntersectionObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}
Object.defineProperty(globalThis, 'IntersectionObserver', { value: IntersectionObserverStub, writable: true });

vi.mock('../src/api/client', () => ({
  api: { activity: vi.fn() },
}));

import { api } from '../src/api/client';

const commit: ActivityEntry = {
  kind: 'commit',
  sha: 'sha-abcdef',
  message: 'feat: add thing\nmore details',
  additions: 12,
  deletions: 3,
  repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
  author: { userId: 1, displayName: 'Alice', bitbucketUuid: '{u1}' },
  occurredAt: '2026-05-12T18:00:00.000Z',
};

const pr: ActivityEntry = {
  kind: 'pr',
  prId: 42,
  title: 'feat: shiny',
  state: 'MERGED',
  sourceBranch: 'feat',
  destinationBranch: 'main',
  repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
  author: null,
  occurredAt: '2026-05-12T14:00:00.000Z',
};

async function mountFeed(filters: { actor?: number; repo?: string; project?: string } = {}) {
  const w = mount(ActivityFeed, {
    props: filters,
    global: {
      stubs: {
        // RouterLink → bare <a> so we can assert visible text without booting
        // an actual router.
        RouterLink: { template: '<a><slot /></a>', props: ['to'] },
      },
    },
  });
  // onMounted fires load → api.activity → store update; flush both ticks.
  await flushPromises();
  return w;
}

describe('ActivityFeed', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('renders both commit and pr rows from the API response', async () => {
    vi.mocked(api.activity).mockResolvedValueOnce([commit, pr]);

    const w = await mountFeed();

    expect(w.text()).toContain('feat: add thing');
    expect(w.text()).toContain('+12 −3');
    expect(w.text()).toContain('#42 feat: shiny');
    expect(w.text()).toContain('feat → main');
    expect(w.text()).toContain('Alice');
    expect(w.text()).toContain('anonymous');
  });

  it('truncates commit message to the first line', async () => {
    vi.mocked(api.activity).mockResolvedValueOnce([commit]);

    const w = await mountFeed();

    expect(w.text()).toContain('feat: add thing');
    expect(w.text()).not.toContain('more details');
  });

  it('shows the empty state when API returns []', async () => {
    vi.mocked(api.activity).mockResolvedValueOnce([]);

    const w = await mountFeed();

    expect(w.text()).toContain('No activity yet for this view');
  });

  it('forwards filter props into the API call', async () => {
    vi.mocked(api.activity).mockResolvedValueOnce([]);

    await mountFeed({ actor: 7, repo: 'tigerit/r1' });

    expect(api.activity).toHaveBeenCalledWith({ actor: 7, repo: 'tigerit/r1', limit: 50 });
  });

  it('renders an uppercase state badge for PR entries', async () => {
    vi.mocked(api.activity).mockResolvedValueOnce([pr]);

    const w = await mountFeed();

    // The badge classes apply uppercase-ing styles; the rendered text is
    // the raw state token.
    expect(w.text()).toContain('MERGED');
  });
});
