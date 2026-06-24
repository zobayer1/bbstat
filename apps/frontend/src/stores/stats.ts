import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { ContributorWindow, OverviewStats, TopContributorEntity, TrackedRepositorySummary } from '@/api/client';
import { liveBus } from '@/lib/live';

// Dashboard cache: /api/stats/overview + /top-contributors + /repositories.
// Persisted so the dashboard stays usable across reloads even when the
// backend is briefly unreachable (offline-first).
export const useStatsStore = defineStore(
  'stats',
  () => {
    const overview = ref<OverviewStats | null>(null);
    const topContributors = ref<TopContributorEntity[]>([]);
    const repositories = ref<TrackedRepositorySummary[]>([]);
    const contributorsWindow = ref<ContributorWindow>('7d');
    const lastSyncedAt = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);
    // BB credential health — flips when the sync runner observes a 401/403.
    // Non-persisted: a rotated token shouldn't stay red after reload, so we
    // want a fresh value on boot. Dashboard fetches it on mount; the SSE
    // `bitbucket.auth-state` event pushes subsequent transitions.
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
        // Network error reading the health flag is a non-event — leave the
        // previous value alone (defaults to 'ok' on first boot).
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

    // Skip if nothing has ever been loaded — the next dashboard navigation
    // triggers the first fetch, so a sleeping tab isn't woken into network work.
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
    // The dashboard Top Contributors panel is person-aware, so any
    // person-layer mutation reshapes its rows. Re-fetch on all of them.
    liveBus.on('person.created', () => {
      void applyTickComplete();
    });
    liveBus.on('person.updated', () => {
      void applyTickComplete();
    });
    liveBus.on('person.attached', () => {
      void applyTickComplete();
    });
    liveBus.on('person.detached', () => {
      void applyTickComplete();
    });
    liveBus.on('person.primary-changed', () => {
      void applyTickComplete();
    });
    liveBus.on('person.dissolved', () => {
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
