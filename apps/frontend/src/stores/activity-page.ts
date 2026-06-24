import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, type ActivityActor, type ActivityEntry } from '@/api/client';
import { liveBus } from '@/lib/live';

// Filter axes for the dedicated Activity page. Wider than the embedded
// ActivityFeed's set (actor / repo / project): adds date-range bounds,
// commit-hash prefix, and free-text message search. Flat shape so URL <->
// store wiring is mechanical.
export interface ActivityPageFilters {
  actor?: ActivityActor;
  repo?: string;
  project?: string;
  after?: string; // ISO 8601, inclusive lower bound
  before?: string; // ISO 8601, exclusive upper bound (range only — NOT a cursor)
  hashPrefix?: string;
  message?: string;
}

export const ACTIVITY_PAGE_SIZE = 100;

// Paginated mirror of the activity feed for the /activity page. Distinct from
// `useActivityStore` (cursor-based infinite scroll) because the page wants
// direct First / Prev / Next / Last navigation.
//
// Pagination is OFFSET-based, with a paired count query per load for "Page X
// of Y" + the Last button. The phantom-read risk (commits arriving between
// requests shift the offset) is acceptable: live updates re-fetch page 1
// anyway, and a repeated row across a tick is less surprising in an activity
// log than broken pagination.
//
// Not persisted (same rationale as `useActivityStore`).
export const useActivityPageStore = defineStore('activity-page', () => {
  const entries = ref<ActivityEntry[]>([]);
  const total = ref(0);
  const page = ref(1);
  const loading = ref(false);
  const error = ref<string | null>(null);
  // Last filter set, so live handlers can re-fetch without the caller
  // re-supplying it. Null before first load — applyTick is then a no-op.
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
      // Entries + count in parallel — count is slower on large sets but only
      // feeds the page indicator + Last button, so don't block the row render.
      const [rows, counted] = await Promise.all([
        api.activity({ ...filters, limit: ACTIVITY_PAGE_SIZE, offset }),
        api.activityCount(filters),
      ]);
      entries.value = rows;
      total.value = counted.total;
      // Clamp against the total — if the target page no longer exists
      // (filters narrowed since the request), settle on the last reachable.
      const maxPage = Math.max(1, Math.ceil(counted.total / ACTIVITY_PAGE_SIZE));
      page.value = Math.min(Math.max(1, targetPage), maxPage);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

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

  // Refetch page 1 of the last filter set. Pagination intentionally resets —
  // new commits land at the top, the user shouldn't be left N pages deep in
  // stale data. Mirrors stores/activity.ts:applyTickComplete.
  async function applyTickComplete(): Promise<void> {
    if (lastFilters.value === null) return;
    await load(lastFilters.value);
  }

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
