import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { UserSummary } from '@/api/client';

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

    return { byUserId, loading, error, fetch, clear };
  },
  { persist: { pick: ['byUserId'] } },
);
