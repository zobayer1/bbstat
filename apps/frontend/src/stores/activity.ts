import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  occurredAt: string;
}

// Pinia is the client-side cache (per CLAUDE.md). Backend is the source of truth;
// this store holds the working copy and is persisted across reloads for offline-first reads.
export const useActivityStore = defineStore(
  'activity',
  () => {
    const entries = ref<ActivityEntry[]>([]);
    const lastSyncedAt = ref<string | null>(null);

    function setEntries(next: ActivityEntry[]) {
      entries.value = next;
      lastSyncedAt.value = new Date().toISOString();
    }

    function clear() {
      entries.value = [];
      lastSyncedAt.value = null;
    }

    return { entries, lastSyncedAt, setEntries, clear };
  },
  { persist: true },
);
