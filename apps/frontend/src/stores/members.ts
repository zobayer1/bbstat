import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { ContributorWindow, WorkspaceMember } from '@/api/client';
import { liveBus } from '@/lib/live';

// Client-side cache for the /members page. Hydrates from
// /api/stats/members and persists across reloads so the page renders
// instantly with the previous payload while a fresh fetch runs in
// the background. Fuzzy search, sort, and pagination all run on the
// frontend over `members.value` — the backend ships the full eligible
// roster (commitsAllTime > 0) in one round-trip.
export const useMembersStore = defineStore(
  'members',
  () => {
    const members = ref<WorkspaceMember[]>([]);
    const window = ref<ContributorWindow>('7d');
    const lastFetchedAt = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);

    async function fetch(): Promise<void> {
      loading.value = true;
      error.value = null;
      try {
        members.value = await api.members(window.value);
        lastFetchedAt.value = new Date().toISOString();
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value = false;
      }
    }

    async function setWindow(next: ContributorWindow): Promise<void> {
      if (next === window.value) return;
      window.value = next;
      await fetch();
    }

    function clear(): void {
      members.value = [];
      lastFetchedAt.value = null;
      error.value = null;
    }

    // Re-fetch when a sync tick lands or push goes stale. Skip if nothing
    // has ever been loaded — the next navigation to /members will trigger
    // the first fetch on its own, no point waking a sleeping tab into
    // network work. Subscribes to the same events as `useUserSummaryStore`
    // since both stores derive their numbers from `commit_daily` aggregates
    // (PR ticks don't move any field in the WorkspaceMember payload, so
    // we deliberately skip `tick.prs.complete`).
    async function applyTickComplete(): Promise<void> {
      if (lastFetchedAt.value === null) return;
      await fetch();
    }

    liveBus.on('tick.commits.complete', () => {
      void applyTickComplete();
    });
    liveBus.on('repository.deleted', () => {
      void applyTickComplete();
    });
    liveBus.onFallback(() => {
      void applyTickComplete();
    });

    return { members, window, lastFetchedAt, loading, error, fetch, setWindow, clear, applyTickComplete };
  },
  { persist: { pick: ['members', 'window', 'lastFetchedAt'] } },
);
