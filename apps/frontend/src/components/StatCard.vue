<script setup lang="ts">
// `value` / `hint` are the simple-string path; callers needing styled content
// (e.g. +adds / −dels in green/red) use the `value` / `hint` slots, which win
// when provided.
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
