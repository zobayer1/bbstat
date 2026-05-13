import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type ActivityEntry } from '@/api/client';

// Filter axes for the activity feed. The store keys its cache by the
// serialized triple, so switching between an actor-filtered view and the
// org-wide view doesn't blow away the data we already paginated.
export interface ActivityFilters {
  actor?: number;
  repo?: string; // "<workspace>/<slug>"
  project?: string;
}

const PAGE_SIZE = 50;

// Hard ceiling on how many entries any single filtered view will accumulate
// in memory. Once a filter set reaches this many entries, `loadMore` is a
// no-op — the UI surfaces a "narrow your filter" hint. Defensive against
// runaway scroll on a workspace with thousands of ingested commits + PRs:
// 500 rows is plenty to skim, the DOM stays responsive, and the
// per-filter Pinia cache stays small.
export const MAX_ENTRIES_PER_FILTER = 500;

function keyFor(filters: ActivityFilters): string {
  return JSON.stringify({
    actor: filters.actor ?? null,
    repo: filters.repo ?? null,
    project: filters.project ?? null,
  });
}

// Keyed cache of paginated activity-feed pages. Pinia is the client-side
// cache per CLAUDE.md — backend is the source of truth. Intentionally NOT
// persisted: an "activity feed" is volatile by nature, and persisting it
// would write potentially hundreds of KB to localStorage on every page
// navigation as a user scrolls. Fresh fetch on mount is what you actually
// want here.
export const useActivityStore = defineStore('activity', () => {
  const byKey = ref<Record<string, ActivityEntry[]>>({});
  const loading = ref<Record<string, boolean>>({});
  const error = ref<Record<string, string | null>>({});
  // `exhausted` is set when a fetch returns fewer rows than PAGE_SIZE —
  // signals "no more pages on the server" so the IntersectionObserver
  // sentinel doesn't keep firing loadMore.
  const exhausted = ref<Record<string, boolean>>({});

  async function load(filters: ActivityFilters): Promise<void> {
    const key = keyFor(filters);
    loading.value[key] = true;
    error.value[key] = null;
    try {
      const entries = await api.activity({ ...filters, limit: PAGE_SIZE });
      byKey.value[key] = entries;
      exhausted.value[key] = entries.length < PAGE_SIZE;
    } catch (e) {
      error.value[key] = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value[key] = false;
    }
  }

  async function loadMore(filters: ActivityFilters): Promise<void> {
    const key = keyFor(filters);
    if (exhausted.value[key] === true) return;
    const current = byKey.value[key] ?? [];
    // Defensive cap: stop accumulating once we hit the per-filter ceiling.
    // The component's IntersectionObserver also checks `isCapped` so we
    // shouldn't normally get here, but a stray callsite or a future tweak
    // shouldn't bypass the ceiling.
    if (current.length >= MAX_ENTRIES_PER_FILTER) return;
    if (current.length === 0) {
      await load(filters);
      return;
    }
    const last = current[current.length - 1]!;
    loading.value[key] = true;
    error.value[key] = null;
    try {
      const more = await api.activity({
        ...filters,
        before: last.occurredAt,
        limit: PAGE_SIZE,
      });
      byKey.value[key] = [...current, ...more];
      exhausted.value[key] = more.length < PAGE_SIZE;
    } catch (e) {
      error.value[key] = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value[key] = false;
    }
  }

  function clear() {
    byKey.value = {};
    loading.value = {};
    error.value = {};
    exhausted.value = {};
  }

  return { byKey, loading, error, exhausted, keyFor, load, loadMore, clear };
});
