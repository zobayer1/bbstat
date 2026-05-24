import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { PersonSummary } from '@/api/client';
import { liveBus } from '@/lib/live';

// Keyed cache of per-person summaries (Phase 5 alias merge). Same
// offline-first shape as useUserSummaryStore — components read
// `byPersonId[id]` synchronously and reconcile against the backend
// when online. Persisted across reloads; only the payloads, not the
// transient loading / error maps.
export const usePersonSummaryStore = defineStore(
  'personSummary',
  () => {
    const byPersonId = ref<Record<number, PersonSummary>>({});
    const loading = ref<Record<number, boolean>>({});
    const error = ref<Record<number, string | null>>({});

    async function fetch(personId: number): Promise<void> {
      loading.value[personId] = true;
      error.value[personId] = null;
      try {
        byPersonId.value[personId] = await api.personSummary(personId);
      } catch (e) {
        error.value[personId] = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value[personId] = false;
      }
    }

    function clear(): void {
      byPersonId.value = {};
      error.value = {};
    }

    // Re-fetch every cached person summary. Cheap when one person is
    // in view; parallel + per-person error isolation otherwise.
    async function applyTickComplete(): Promise<void> {
      const ids = Object.keys(byPersonId.value).map(Number);
      await Promise.all(ids.map((id) => fetch(id)));
    }

    // Commit ticks and sync-state transitions move the same
    // commit_daily-derived numbers the person page renders, exactly
    // as for the user page.
    liveBus.on('tick.commits.complete', () => {
      void applyTickComplete();
    });
    liveBus.on('repository.sync-excluded', () => {
      void applyTickComplete();
    });
    liveBus.on('repository.included', () => {
      void applyTickComplete();
    });
    liveBus.on('repository.deleted', () => {
      void applyTickComplete();
    });
    // Person-layer mutations change the attached-alias roster (and
    // therefore every aggregate). A dissolve of the person currently
    // in view drops its cache entry so a stale page doesn't linger.
    liveBus.on('person.attached', () => {
      void applyTickComplete();
    });
    liveBus.on('person.detached', () => {
      void applyTickComplete();
    });
    liveBus.on('person.primary-changed', () => {
      void applyTickComplete();
    });
    liveBus.on('person.updated', () => {
      void applyTickComplete();
    });
    liveBus.on('person.dissolved', (payload) => {
      delete byPersonId.value[payload.personId];
      delete loading.value[payload.personId];
      delete error.value[payload.personId];
    });
    liveBus.onFallback(() => {
      void applyTickComplete();
    });

    return { byPersonId, loading, error, fetch, clear, applyTickComplete };
  },
  { persist: { pick: ['byPersonId'] } },
);
