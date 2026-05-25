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

// Hard ceiling on how many entries any single filtered view will accumulate
// in memory. Once a filter set reaches this many entries, `loadMore` is a
// no-op — the UI surfaces a "narrow your filter" hint. Defensive against
// runaway scroll on a workspace with thousands of ingested commits + PRs:
// 500 rows is plenty to skim, the DOM stays responsive, and the
// per-filter Pinia cache stays small.
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

  // Live updates: re-fetch the first page for every currently-loaded
  // filter. New entries surface at the top; pagination state (the
  // user's accumulated additional pages) is intentionally NOT
  // preserved — `load()` overwrites `byKey[key]` with the fresh page.
  // For an activity feed this is the right call: a "live" feed
  // shouldn't strand the user 10 pages deep in stale data when a tick
  // just landed new commits at the top.
  async function applyTickComplete(): Promise<void> {
    const keys = Object.keys(byKey.value);
    await Promise.all(
      keys.map((key) => {
        const filters = JSON.parse(key) as { actor: string | null; repo: string | null; project: string | null };
        const restored: ActivityFilters = {};
        if (filters.actor !== null) {
          // Stored as "kind:id" (see keyFor) — split back into the
          // discriminated actor.
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

  // Wire push + polling fallback. Both call applyTickComplete so the
  // store has one re-fetch path regardless of trigger. Stays registered
  // for the app lifetime — Pinia stores aren't torn down in an SPA.
  liveBus.on('tick.commits.complete', () => {
    void applyTickComplete();
  });
  liveBus.on('tick.prs.complete', () => {
    void applyTickComplete();
  });
  liveBus.on('repository.deleted', () => {
    void applyTickComplete();
  });
  // Phase 5 — attach / detach / dissolve changes which commits a person
  // filter resolves to, so any cached person-filtered feed must refetch.
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
