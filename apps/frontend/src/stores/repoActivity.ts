import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { RepoActivity } from '@/api/client';
import { liveBus } from '@/lib/live';

// Keyed cache of per-repo activity, indexed by "<workspace>/<slug>".
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

    // Re-fetch every cached repo's activity payload. Per-repo events also
    // drive a global refresh — the payload is small enough to not bother
    // with finer-grained patching.
    async function applyTickComplete(): Promise<void> {
      const keys = Object.keys(byFullName.value);
      await Promise.all(
        keys.map((key) => {
          const [workspace, slug] = key.split('/', 2);
          if (workspace === undefined || slug === undefined) return Promise.resolve();
          return fetch(workspace, slug);
        }),
      );
    }

    function dropRepo(fullName: string): void {
      delete byFullName.value[fullName];
      delete loading.value[fullName];
      delete error.value[fullName];
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
    liveBus.on('repository.deleted', (payload) => {
      // Drop rather than re-fetch — a re-fetch would 404.
      dropRepo(payload.fullName);
    });
    liveBus.onFallback(() => {
      void applyTickComplete();
    });

    return { byFullName, loading, error, fetch, clear, keyFor, applyTickComplete };
  },
  { persist: { pick: ['byFullName'] } },
);
