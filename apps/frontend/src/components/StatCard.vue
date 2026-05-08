<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  hint?: string;
}>();
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div class="text-sm font-medium text-slate-500">{{ label }}</div>
    <div class="mt-1 text-2xl font-semibold text-slate-900">{{ value }}</div>
    <div v-if="hint" class="mt-1 text-xs text-slate-400">{{ hint }}</div>
  </div>
</template>
