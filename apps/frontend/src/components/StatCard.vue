<script setup lang="ts">
// `value` and `hint` are the simple-string contract; callers that need
// styled / multi-color content (e.g., the repo-detail "Code changes" cards
// rendering +adds / −dels in green/red) can use the `value` / `hint`
// slots instead. Slot content wins when provided.
defineProps<{
  label: string;
  value?: string | number;
  hint?: string;
}>();
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div class="text-sm font-medium text-slate-500">{{ label }}</div>
    <div class="mt-1 text-2xl font-semibold text-slate-900">
      <slot name="value">{{ value }}</slot>
    </div>
    <div v-if="$slots.hint || hint" class="mt-1 text-xs text-slate-400">
      <slot name="hint">{{ hint }}</slot>
    </div>
  </div>
</template>
