import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { UserSummary } from '@/api/client';
import { liveBus } from '@/lib/live';

// Keyed cache of per-user summaries. Offline-first: components read
// `byUserId.value[id]` synchronously (may show a stale-but-present entry while
// `fetch(id)` is in flight). Persisted across reloads via the persisted-state
// plugin — only the cached payloads, not transient loading/error state.
export const useUserSummaryStore = defineStore(
  'userSummary',
  () => {
    const byUserId = ref<Record<number, UserSummary>>({});
    const loading = ref<Record<number, boolean>>({});
    const error = ref<Record<number, string | null>>({});

    async function fetch(userId: number): Promise<void> {
      loading.value[userId] = true;
      error.value[userId] = null;
      try {
        byUserId.value[userId] = await api.userSummary(userId);
      } catch (e) {
        error.value[userId] = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value[userId] = false;
      }
    }

    function clear() {
      byUserId.value = {};
      error.value = {};
    }

    // Re-fetch every currently-cached user summary. Cheap when only
    // one user is in view; if many are cached from prior navigation
    // they all refresh in parallel. Errors per-user; one failure
    // doesn't poison the others.
    async function applyTickComplete(): Promise<void> {
      const ids = Object.keys(byUserId.value).map(Number);
      await Promise.all(ids.map((id) => fetch(id)));
    }

    liveBus.on('tick.commits.complete', () => {
      void applyTickComplete();
    });
    // Sync-state transitions matter here because the user-detail
    // "Top repos" table renders the SyncStateIcon — when a repo
    // auto-trips into the excluded state, the icon's colour should
    // flip without waiting for a fallback poll. Same on the
    // operator-driven un-exclude side.
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

    return { byUserId, loading, error, fetch, clear, applyTickComplete };
  },
  { persist: { pick: ['byUserId'] } },
);
