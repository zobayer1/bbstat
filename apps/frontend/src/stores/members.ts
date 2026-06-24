import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { WorkspaceMember } from '@/api/client';
import { liveBus } from '@/lib/live';

// Client-side cache for the /members page. Persists so the page renders
// instantly with the previous payload while a fresh fetch runs. Fuzzy
// search, sort, and pagination all run on the frontend over `members.value` —
// the backend ships the full eligible roster (commitsAllTime > 0) in one
// round-trip with BOTH 7d and 30d aggregates per row, so the table renders
// `{commits} ({repos})` cells for each window without client-side toggling.
export const useMembersStore = defineStore(
  'members',
  () => {
    const members = ref<WorkspaceMember[]>([]);
    const lastFetchedAt = ref<string | null>(null);
    const loading = ref(false);
    const error = ref<string | null>(null);

    async function fetch(): Promise<void> {
      loading.value = true;
      error.value = null;
      try {
        members.value = await api.members();
        lastFetchedAt.value = new Date().toISOString();
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      } finally {
        loading.value = false;
      }
    }

    function clear(): void {
      members.value = [];
      lastFetchedAt.value = null;
      error.value = null;
    }

    // Skip if nothing has ever been loaded — the next /members navigation
    // triggers the first fetch, no point waking a sleeping tab into network
    // work. PR ticks don't move any WorkspaceMember field, so we deliberately
    // skip `tick.prs.complete`.
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
    // Any person-layer mutation reshapes the leaderboard (create/attach
    // collapses rows, detach/dissolve splits them, primary swap / name edit
    // relabels), so re-fetch on all of them.
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

    return { members, lastFetchedAt, loading, error, fetch, clear, applyTickComplete };
  },
  { persist: { pick: ['members', 'lastFetchedAt'] } },
);
