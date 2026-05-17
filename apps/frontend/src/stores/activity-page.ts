import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, type ActivityEntry } from '@/api/client';
import { liveBus } from '@/lib/live';

// Filter axes for the dedicated Activity page. Wider than the embedded
// ActivityFeed's filter set (which only owns actor / repo / project): adds
// the date-range bounds + commit-hash prefix + free-text message search.
// Kept as a flat shape so URL <-> store wiring is mechanical.
export interface ActivityPageFilters {
  actor?: number;
  repo?: string;
  project?: string;
  after?: string; // ISO 8601, inclusive lower bound
  before?: string; // ISO 8601, exclusive upper bound (range only — NOT a cursor)
  hashPrefix?: string;
  message?: string;
}

export const ACTIVITY_PAGE_SIZE = 100;

// Paginated mirror of the activity feed for the /activity page. Distinct
// from `useActivityStore` because the embedded feed is infinite-scroll-
// shaped (cursor-based, keyed cache of growing arrays), and the page
// wants direct First / Prev / Next / Last navigation.
//
// Pagination is OFFSET-based: every page-load fires a paired count
// query so the UI can show "Page X of Y" and the Last button knows
// where to land. The phantom-read risk inherent in OFFSET (new commits
// arriving between requests shift the offset) is acceptable here —
// live updates re-fetch page 1 anyway, and the activity log is the one
// place where seeing the same row twice across a tick boundary is
// less surprising than seeing pagination break.
//
// Not persisted, same rationale as `useActivityStore` — activity is
// volatile by nature, and persisting hundreds of rows on every nav
// would bloat localStorage with data the next visit should refresh.
export const useActivityPageStore = defineStore('activity-page', () => {
  const entries = ref<ActivityEntry[]>([]);
  const total = ref(0);
  const page = ref(1);
  const loading = ref(false);
  const error = ref<string | null>(null);
  // Last filter set in use, so SSE/live handlers can re-fetch without
  // the caller re-supplying it. Null before the first load — applyTick
  // is then a no-op so a sleeping tab isn't yanked into network work.
  const lastFilters = ref<ActivityPageFilters | null>(null);

  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / ACTIVITY_PAGE_SIZE)));
  const canPrev = computed(() => page.value > 1);
  const canNext = computed(() => page.value < pageCount.value);
  const canFirst = computed(() => page.value > 1);
  const canLast = computed(() => page.value < pageCount.value);

  async function fetchPage(filters: ActivityPageFilters, targetPage: number): Promise<void> {
    lastFilters.value = filters;
    loading.value = true;
    error.value = null;
    try {
      const offset = (targetPage - 1) * ACTIVITY_PAGE_SIZE;
      // Run entries + count in parallel — count is the slower of the two
      // on large filtered sets but the UI only needs it for the page
      // indicator + Last button, so don't block the row render on it.
      const [rows, counted] = await Promise.all([
        api.activity({ ...filters, limit: ACTIVITY_PAGE_SIZE, offset }),
        api.activityCount(filters),
      ]);
      entries.value = rows;
      total.value = counted.total;
      // Clamp the target page against the total — if the user jumped
      // to a page that no longer exists (filters narrowed since the
      // request was issued), settle on the last reachable page.
      const maxPage = Math.max(1, Math.ceil(counted.total / ACTIVITY_PAGE_SIZE));
      page.value = Math.min(Math.max(1, targetPage), maxPage);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  // Fresh page-1 load — also used for filter changes.
  async function load(filters: ActivityPageFilters): Promise<void> {
    await fetchPage(filters, 1);
  }

  async function first(filters: ActivityPageFilters): Promise<void> {
    if (!canFirst.value) return;
    await fetchPage(filters, 1);
  }

  async function prev(filters: ActivityPageFilters): Promise<void> {
    if (!canPrev.value) return;
    await fetchPage(filters, page.value - 1);
  }

  async function next(filters: ActivityPageFilters): Promise<void> {
    if (!canNext.value) return;
    await fetchPage(filters, page.value + 1);
  }

  async function last(filters: ActivityPageFilters): Promise<void> {
    if (!canLast.value) return;
    await fetchPage(filters, pageCount.value);
  }

  function clear(): void {
    entries.value = [];
    total.value = 0;
    page.value = 1;
    loading.value = false;
    error.value = null;
    lastFilters.value = null;
  }

  // Refetch page 1 of the last-used filter set when a sync tick lands or
  // the SSE push goes stale. Pagination intentionally resets — new
  // commits land at the top, the user shouldn't be left N pages deep
  // in stale data. Mirrors the embedded ActivityFeed store's tick
  // handling (apps/frontend/src/stores/activity.ts:applyTickComplete).
  async function applyTickComplete(): Promise<void> {
    if (lastFilters.value === null) return;
    await load(lastFilters.value);
  }

  // SSE wiring. Stays registered for the app lifetime — Pinia stores
  // aren't torn down in an SPA, and the same store instance is reused
  // across /activity visits.
  liveBus.on('tick.commits.complete', () => {
    void applyTickComplete();
  });
  liveBus.on('tick.prs.complete', () => {
    void applyTickComplete();
  });
  liveBus.on('repository.deleted', () => {
    void applyTickComplete();
  });
  liveBus.onFallback(() => {
    void applyTickComplete();
  });

  return {
    entries,
    total,
    page,
    pageCount,
    loading,
    error,
    canPrev,
    canNext,
    canFirst,
    canLast,
    load,
    first,
    prev,
    next,
    last,
    clear,
    applyTickComplete,
  };
});
