<script setup lang="ts">
// Compact connection-state indicator for the live updates surface.
// Renders nothing while the SSE pipe is healthy ('open') — the operator
// shouldn't need a status badge to tell them "everything's fine."
// Surfaces a small pill when the stream is reconnecting (the
// EventSource is mid-retry per the backend's `retry: 5000` directive)
// or closed (parent component is shutting down — typically only seen
// briefly on app teardown).

import { computed } from 'vue';
import type { LiveConnectionState } from '@/lib/live';

const props = defineProps<{
  state: LiveConnectionState;
}>();

const visible = computed(() => props.state !== 'open');
const label = computed(() => {
  if (props.state === 'connecting') return 'Reconnecting…';
  if (props.state === 'closed') return 'Disconnected';
  return '';
});
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    leave-active-class="transition-opacity duration-300"
    enter-from-class="opacity-0"
    leave-to-class="opacity-0"
  >
    <span
      v-if="visible"
      class="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200"
      :title="label"
      role="status"
      aria-live="polite"
    >
      <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
      {{ label }}
    </span>
  </Transition>
</template>
