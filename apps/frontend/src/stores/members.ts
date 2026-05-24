import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { WorkspaceMember } from '@/api/client';
import { liveBus } from '@/lib/live';

// Client-side cache for the /members page. Hydrates from
// /api/stats/members and persists across reloads so the page renders
// instantly with the previous payload while a fresh fetch runs in
// the background. Fuzzy search, sort, and pagination all run on the
// frontend over `members.value` — the backend ships the full eligible
// roster (commitsAllTime > 0) in one round-trip with BOTH 7d and 30d
// aggregates per row, so the table can render `{commits} ({repos})`
// cells for each window without any client-side toggling.
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
    // Phase 5 — any person-layer mutation reshapes the leaderboard:
    // a create / attach collapses rows into one, a detach / dissolve
    // splits them back out, and a primary swap or display-name edit
    // changes a row's label. All of them warrant a re-fetch so the
    // table reflects the new merge state without a manual reload.
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
