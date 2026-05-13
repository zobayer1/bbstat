<script setup lang="ts">
import { computed } from 'vue';
import type { RepoSyncStatus } from '@/api/client';

const props = defineProps<{
  // Optional, not required. Older cached payloads (pre-syncStatus) won't
  // carry the field; treating undefined as 'never' lets stale Pinia state
  // render without crashing. The next backend fetch refreshes it.
  status: RepoSyncStatus | undefined;
}>();

type Shape = 'check' | 'warn' | 'dash';

const META: Record<RepoSyncStatus, { label: string; tone: string; shape: Shape }> = {
  ok: { label: 'Synced', tone: 'text-emerald-600', shape: 'check' },
  error: { label: 'Sync error', tone: 'text-amber-600', shape: 'warn' },
  never: { label: 'Not synced yet', tone: 'text-slate-400', shape: 'dash' },
};

const meta = computed(() => META[props.status ?? 'never']);
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
    <svg
      v-else
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      class="h-3.5 w-3.5"
    >
      <circle cx="8" cy="8" r="5" />
    </svg>
  </span>
</template>
