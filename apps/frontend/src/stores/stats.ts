import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { OverviewStats } from '@/api/client';

// Pinia is the client-side cache (per CLAUDE.md). Hydrates from
// /api/stats/overview; the persisted overview keeps the dashboard usable
// across reloads even when the backend is briefly unreachable (offline-first).
export const useStatsStore = defineStore(
  'stats',
  () => {
    const overview = ref<OverviewStats | null>(null);
    const lastSyncedAt = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);

    async function fetchOverview() {
      loading.value = true;
      error.value = null;
      try {
        overview.value = await api.statsOverview();
        lastSyncedAt.value = new Date().toISOString();
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value = false;
      }
    }

    function clear() {
      overview.value = null;
      lastSyncedAt.value = null;
      error.value = null;
    }

    return { overview, lastSyncedAt, loading, error, fetchOverview, clear };
  },
  { persist: { pick: ['overview', 'lastSyncedAt'] } },
);
