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
  filesChanged: 4,
  isMerge: false,
  diffStatsUnavailable: false,
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

  it('renders the short sha (first 7 chars) on commit entries', async () => {
    vi.mocked(api.activity).mockResolvedValueOnce([commit]);

    const w = await mountFeed();

    // sha = 'sha-abcdef' (10 chars) → short = 'sha-abc'.
    expect(w.text()).toContain('sha-abc');
    // The full sha shouldn't leak into the rendered text.
    expect(w.text()).not.toContain('sha-abcdef');
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

  describe('commit detail modal', () => {
    const commitA: ActivityEntry = { ...commit, sha: 'sha-a-1234567', message: 'first\nbody-a' };
    const commitB: ActivityEntry = { ...commit, sha: 'sha-b-1234567', message: 'second' };
    const commitC: ActivityEntry = { ...commit, sha: 'sha-c-1234567', message: 'third\nbody-c' };

    it('opens with the full message + BB link when a commit row is clicked', async () => {
      vi.mocked(api.activity).mockResolvedValueOnce([commitA]);

      const w = await mountFeed();
      await w.find('button').trigger('click');

      // Full message (subject + body), not just the truncated first line.
      expect(w.text()).toContain('first');
      expect(w.text()).toContain('body-a');
      // External BB link with the full sha.
      const link = w.find('a[href^="https://bitbucket.org/"]');
      expect(link.exists()).toBe(true);
      expect(link.attributes('href')).toContain('sha-a-1234567');
      expect(link.attributes('target')).toBe('_blank');
    });

    it('prev/next walks through commit-kind entries; PR rows are skipped', async () => {
      vi.mocked(api.activity).mockResolvedValueOnce([commitA, pr, commitB, commitC]);

      const w = await mountFeed();
      // The commit-row buttons are the only buttons in the rendered list
      // (PRs use a span). Click the first one — commitA.
      const triggers = w.findAll('button').filter((b) => b.text().includes('first'));
      expect(triggers).toHaveLength(1);
      await triggers[0]!.trigger('click');
      expect(w.text()).toContain('body-a');

      // Hit Next → commitB (PR is skipped).
      const nextBtn = w.findAll('button').find((b) => b.text().includes('Next'));
      expect(nextBtn?.attributes('disabled')).toBeUndefined();
      await nextBtn!.trigger('click');
      expect(w.text()).toContain('second');

      // Hit Next → commitC.
      const nextBtn2 = w.findAll('button').find((b) => b.text().includes('Next'));
      await nextBtn2!.trigger('click');
      expect(w.text()).toContain('body-c');

      // At the last commit, Next is disabled.
      const finalNext = w.findAll('button').find((b) => b.text().includes('Next'));
      expect(finalNext?.attributes('disabled')).toBeDefined();
    });

    it('Esc keypress closes the modal', async () => {
      vi.mocked(api.activity).mockResolvedValueOnce([commitA]);

      const w = await mountFeed();
      await w.find('button').trigger('click');
      expect(w.text()).toContain('body-a');

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await flushPromises();

      // After close, the modal-only content is gone.
      expect(w.text()).not.toContain('body-a');
    });
  });
});
