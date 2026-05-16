import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/client';
import type { ContributorWindow, WorkspaceMember } from '@/api/client';

// Client-side cache for the /members page. Hydrates from
// /api/stats/members and persists across reloads so the page renders
// instantly with the previous payload while a fresh fetch runs in
// the background. Fuzzy search, sort, and pagination all run on the
// frontend over `members.value` — the backend ships the full eligible
// roster (commitsAllTime > 0) in one round-trip.
//
// SSE wiring (refetch on tick.commits.complete / tick.prs.complete /
// repository.deleted) lands in a subsequent commit alongside the
// per-row sparkline integration. The store shape is already
// SSE-ready; the next commit just adds `liveBus.on(...)` handlers.
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

    return { members, window, lastFetchedAt, loading, error, fetch, setWindow, clear };
  },
  { persist: { pick: ['members', 'window', 'lastFetchedAt'] } },
);
