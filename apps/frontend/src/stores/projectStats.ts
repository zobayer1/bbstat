import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { ProjectStats } from '@/api/client';

// Keyed cache of per-project stats. Same offline-first pattern as
// userSummary — components render from `byProjectKey.value[key]` and refresh
// asynchronously via `fetch(key)`.
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

    return { byProjectKey, loading, error, fetch, clear };
  },
  { persist: { pick: ['byProjectKey'] } },
);
