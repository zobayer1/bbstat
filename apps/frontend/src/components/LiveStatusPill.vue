<script setup lang="ts">
// Connection-state pill for live updates. Renders nothing while the SSE pipe
// is 'open' — no badge needed to say "everything's fine". Shows when the
// EventSource is reconnecting or closed.

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
