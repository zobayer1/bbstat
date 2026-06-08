<script setup lang="ts">
import { computed } from 'vue';
import type { RepoSyncStatus } from '@/api/client';

const props = defineProps<{
  // Optional, not required. Older cached payloads (pre-syncStatus) won't
  // carry the field; treating undefined as 'never' lets stale Pinia state
  // render without crashing. The next backend fetch refreshes it.
  status: RepoSyncStatus | undefined;
  // When true (the repo is archived/retired), the icon renders neutral
  // regardless of `status` — a retired repo never reads as "needs
  // attention", even if its frozen last-sync status was error/excluded.
  archived?: boolean;
}>();

type Shape = 'check' | 'warn' | 'dash';

const META: Record<RepoSyncStatus, { label: string; tone: string; shape: Shape }> = {
  ok: { label: 'Synced', tone: 'text-emerald-600', shape: 'check' },
  error: { label: 'Sync error', tone: 'text-amber-600', shape: 'warn' },
  // Same triangle shape as 'error' but red — the underlying cause is
  // durable (rename / force-push) and the recovery is a specific admin
  // action, not a wait-and-retry.
  excluded: { label: 'Excluded from sync — needs attention', tone: 'text-red-600', shape: 'warn' },
  never: { label: 'Not synced yet', tone: 'text-slate-400', shape: 'dash' },
  // Benign: empty on BitBucket, nothing to sync. Neutral dash (not a
  // warning) so it doesn't read as a problem needing attention.
  empty: { label: 'Empty on BitBucket — nothing to sync', tone: 'text-slate-400', shape: 'dash' },
};

// Archived repos are paused, not broken — show a neutral dash, never a
// warning triangle, whatever the frozen sync status underneath is.
const ARCHIVED_META: { label: string; tone: string; shape: Shape } = {
  label: 'Archived — sync paused',
  tone: 'text-slate-400',
  shape: 'dash',
};

const meta = computed(() => (props.archived ? ARCHIVED_META : META[props.status ?? 'never']));
</script>

<template>
  <span
    :class="['inline-flex h-4 w-4 items-center justify-center', meta.tone]"
    :title="meta.label"
    :aria-label="meta.label"
    role="img"
  >
    <svg
      v-if="meta.shape === 'check'"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5"
    >
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
    <svg
      v-else-if="meta.shape === 'warn'"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3.5 w-3.5"
    >
      <path d="M8 2.5L14.5 13.5h-13L8 2.5z" />
      <path d="M8 7v3" />
      <circle cx="8" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </svg>
    <!-- 'dash' shape — a literal horizontal dash, visually unambiguous
         against the check (✓) and the warn triangle. The previous
         hollow-circle rendering of this state read too similarly to the
         warn triangle's stroked outline at 14×14 px. -->
    <svg
      v-else
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      class="h-3.5 w-3.5"
    >
      <path d="M3 8h10" />
    </svg>
  </span>
</template>
