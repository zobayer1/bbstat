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

function keyFor(filters: ActivityFilters): string {
  return JSON.stringify({
    actor: filters.actor ?? null,
    repo: filters.repo ?? null,
    project: filters.project ?? null,
  });
}

// Keyed cache of paginated activity-feed pages. Pinia is the client-side
// cache per CLAUDE.md — backend is the source of truth. Persisted across
// reloads (the data, not transient loading / error state) so a return to a
// previously-loaded filter view shows the prior data immediately while the
// network re-syncs.
export const useActivityStore = defineStore(
  'activity',
  () => {
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
  },
  // Persist the cached pages + exhausted flags; loading / error are
  // transient and should reset per reload.
  { persist: { pick: ['byKey', 'exhausted'] } },
);
