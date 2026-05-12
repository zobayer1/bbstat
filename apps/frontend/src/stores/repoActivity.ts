import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { RepoActivity } from '@/api/client';

// Keyed cache of per-repo activity, indexed by "<workspace>/<slug>" so the
// key is stable and round-trips through URLs cleanly.
export const useRepoActivityStore = defineStore(
  'repoActivity',
  () => {
    const byFullName = ref<Record<string, RepoActivity>>({});
    const loading = ref<Record<string, boolean>>({});
    const error = ref<Record<string, string | null>>({});

    function keyFor(workspace: string, slug: string): string {
      return `${workspace}/${slug}`;
    }

    async function fetch(workspace: string, slug: string): Promise<void> {
      const key = keyFor(workspace, slug);
      loading.value[key] = true;
      error.value[key] = null;
      try {
        byFullName.value[key] = await api.repositoryActivity(workspace, slug);
      } catch (e) {
        error.value[key] = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value[key] = false;
      }
    }

    function clear() {
      byFullName.value = {};
      error.value = {};
    }

    return { byFullName, loading, error, fetch, clear, keyFor };
  },
  { persist: { pick: ['byFullName'] } },
);
