import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { ProjectStats } from '@/api/client';
import { liveBus } from '@/lib/live';

// Keyed cache of per-project stats. Same offline-first pattern as userSummary.
export const useProjectStatsStore = defineStore(
  'projectStats',
  () => {
    const byProjectKey = ref<Record<string, ProjectStats>>({});
    const loading = ref<Record<string, boolean>>({});
    const error = ref<Record<string, string | null>>({});

    async function fetch(projectKey: string): Promise<void> {
      loading.value[projectKey] = true;
      error.value[projectKey] = null;
      try {
        byProjectKey.value[projectKey] = await api.projectStats(projectKey);
      } catch (e) {
        error.value[projectKey] = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value[projectKey] = false;
      }
    }

    function clear() {
      byProjectKey.value = {};
      error.value = {};
    }

    async function applyTickComplete(): Promise<void> {
      const keys = Object.keys(byProjectKey.value);
      await Promise.all(keys.map((k) => fetch(k)));
    }

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
    liveBus.onFallback(() => {
      void applyTickComplete();
    });

    return { byProjectKey, loading, error, fetch, clear, applyTickComplete };
  },
  { persist: { pick: ['byProjectKey'] } },
);
