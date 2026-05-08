import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { ContributorWindow, OverviewStats, TopContributor } from '@/api/client';

// Pinia is the client-side cache (per CLAUDE.md). Hydrates from
// /api/stats/overview + /api/stats/top-contributors; persisted state keeps
// the dashboard usable across reloads even when the backend is briefly
// unreachable (offline-first).
export const useStatsStore = defineStore(
  'stats',
  () => {
    const overview = ref<OverviewStats | null>(null);
    const topContributors = ref<TopContributor[]>([]);
    const contributorsWindow = ref<ContributorWindow>('7d');
    const lastSyncedAt = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);

    async function fetchOverview() {
      loading.value = true;
      error.value = null;
      try {
        const [ov, contribs] = await Promise.all([api.statsOverview(), api.topContributors(contributorsWindow.value)]);
        overview.value = ov;
        topContributors.value = contribs;
        lastSyncedAt.value = new Date().toISOString();
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value = false;
      }
    }

    async function setContributorsWindow(next: ContributorWindow) {
      if (next === contributorsWindow.value) return;
      contributorsWindow.value = next;
      try {
        topContributors.value = await api.topContributors(next);
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      }
    }

    function clear() {
      overview.value = null;
      topContributors.value = [];
      lastSyncedAt.value = null;
      error.value = null;
    }

    return {
      overview,
      topContributors,
      contributorsWindow,
      lastSyncedAt,
      loading,
      error,
      fetchOverview,
      setContributorsWindow,
      clear,
    };
  },
  { persist: { pick: ['overview', 'topContributors', 'contributorsWindow', 'lastSyncedAt'] } },
);
