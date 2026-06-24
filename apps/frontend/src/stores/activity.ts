import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type ActivityActor, type ActivityEntry } from '@/api/client';
import { liveBus } from '@/lib/live';

// Filter axes for the activity feed. The store keys its cache by the
// serialized triple, so switching between an actor-filtered view and the
// org-wide view doesn't blow away the data we already paginated.
export interface ActivityFilters {
  actor?: ActivityActor;
  repo?: string; // "<workspace>/<slug>"
  project?: string;
}

const PAGE_SIZE = 50;

// Hard ceiling per filtered view. Once reached, `loadMore` is a no-op and the
// UI surfaces a "narrow your filter" hint — defends against runaway scroll
// keeping the DOM responsive and the per-filter Pinia cache small.
export const MAX_ENTRIES_PER_FILTER = 500;

function keyFor(filters: ActivityFilters): string {
  return JSON.stringify({
    // Serialize the discriminated actor so a person filter and a user
    // filter with the same numeric id never collide on the same cache key.
    actor: filters.actor === undefined ? null : `${filters.actor.kind}:${filters.actor.id}`,
    repo: filters.repo ?? null,
    project: filters.project ?? null,
  });
}

// Keyed cache of paginated activity-feed pages. Intentionally NOT persisted:
// the feed is volatile, and persisting it would write hundreds of KB to
// localStorage as the user scrolls. Fresh fetch on mount is what we want.
export const useActivityStore = defineStore('activity', () => {
  const byKey = ref<Record<string, ActivityEntry[]>>({});
  const loading = ref<Record<string, boolean>>({});
  const error = ref<Record<string, string | null>>({});
  // Set when a fetch returns fewer rows than PAGE_SIZE — "no more pages",
  // so the IntersectionObserver sentinel stops firing loadMore.
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
    // Defensive cap — the component's IntersectionObserver also checks
    // `isCapped`, but a stray callsite shouldn't bypass the ceiling.
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

  // Re-fetch page 1 for every loaded filter. Accumulated extra pages are
  // intentionally NOT preserved — `load()` overwrites with the fresh page so
  // a live feed doesn't strand the user N pages deep in stale data when a
  // tick lands new commits at the top.
  async function applyTickComplete(): Promise<void> {
    const keys = Object.keys(byKey.value);
    await Promise.all(
      keys.map((key) => {
        const filters = JSON.parse(key) as { actor: string | null; repo: string | null; project: string | null };
        const restored: ActivityFilters = {};
        if (filters.actor !== null) {
          // Stored as "kind:id" (see keyFor) — split back into the actor.
          const sep = filters.actor.indexOf(':');
          const kind = filters.actor.slice(0, sep);
          const id = Number(filters.actor.slice(sep + 1));
          if ((kind === 'user' || kind === 'person') && Number.isFinite(id)) {
            restored.actor = { kind, id };
          }
        }
        if (filters.repo !== null) restored.repo = filters.repo;
        if (filters.project !== null) restored.project = filters.project;
        return load(restored);
      }),
    );
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
  // Attach / detach / dissolve changes which commits a person filter
  // resolves to, so any cached person-filtered feed must refetch.
  liveBus.on('person.attached', () => {
    void applyTickComplete();
  });
  liveBus.on('person.detached', () => {
    void applyTickComplete();
  });
  liveBus.on('person.dissolved', () => {
    void applyTickComplete();
  });
  liveBus.onFallback(() => {
    void applyTickComplete();
  });

  return { byKey, loading, error, exhausted, keyFor, load, loadMore, clear, applyTickComplete };
});
