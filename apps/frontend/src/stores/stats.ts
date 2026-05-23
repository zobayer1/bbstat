import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type {
  ContributorWindow,
  OverviewStats,
  TopContributorWithSparkline,
  TrackedRepositorySummary,
} from '@/api/client';
import { liveBus } from '@/lib/live';

// Pinia is the client-side cache (per CLAUDE.md). Hydrates from
// /api/stats/overview + /api/stats/top-contributors + /api/stats/repositories;
// persisted state keeps the dashboard usable across reloads even when the
// backend is briefly unreachable (offline-first).
export const useStatsStore = defineStore(
  'stats',
  () => {
    const overview = ref<OverviewStats | null>(null);
    const topContributors = ref<TopContributorWithSparkline[]>([]);
    const repositories = ref<TrackedRepositorySummary[]>([]);
    const contributorsWindow = ref<ContributorWindow>('7d');
    const lastSyncedAt = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    // BB credential health — flips when the sync runner observes a 401/403
    // from BitBucket. Non-persisted: we always want a fresh value on boot
    // (a token that expired mid-session shouldn't stay red after the user
    // rotates and reloads). Initial state is 'ok'; the dashboard fetches
    // the real value on mount and the SSE `bitbucket.auth-state` event
    // pushes subsequent transitions.
    const bitbucketAuthState = ref<'ok' | 'unauthorized'>('ok');

    async function fetchOverview() {
      loading.value = true;
      error.value = null;
      try {
        const [ov, contribs, repos] = await Promise.all([
          api.statsOverview(),
          api.topContributors(contributorsWindow.value),
          api.listRepositories(),
        ]);
        overview.value = ov;
        topContributors.value = contribs;
        repositories.value = repos;
        lastSyncedAt.value = new Date().toISOString();
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value = false;
      }
    }

    async function fetchBitbucketAuthState() {
      try {
        const { state } = await api.bitbucketAuthState();
        bitbucketAuthState.value = state;
      } catch {
        // Network error reading the health flag is itself a non-event —
        // leave the previous value alone (defaults to 'ok' on first boot).
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
      repositories.value = [];
      lastSyncedAt.value = null;
      error.value = null;
    }

    // Re-fetch the dashboard aggregates when a tick lands or push
    // goes stale. Skip if nothing has ever been loaded — the next
    // navigation to the dashboard will trigger the first fetch on
    // its own. Avoids waking a sleeping tab into network work.
    async function applyTickComplete(): Promise<void> {
      if (overview.value === null) return;
      await fetchOverview();
    }

    liveBus.on('bitbucket.auth-state', (payload) => {
      bitbucketAuthState.value = payload.state;
    });
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

    return {
      overview,
      topContributors,
      repositories,
      contributorsWindow,
      lastSyncedAt,
      loading,
      error,
      bitbucketAuthState,
      fetchOverview,
      fetchBitbucketAuthState,
      setContributorsWindow,
      clear,
      applyTickComplete,
    };
  },
  { persist: { pick: ['overview', 'topContributors', 'repositories', 'contributorsWindow', 'lastSyncedAt'] } },
);
