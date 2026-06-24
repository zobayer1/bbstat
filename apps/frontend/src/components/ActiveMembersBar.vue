<script setup lang="ts">
// Active-members chart. One bar per bucket, each sized to its own count —
// NOT a stacked partition. Buckets are *cumulative ranges* (active within
// 7 / 30 / 365 days) so 7d ≤ 30d ≤ 1y by construction; a stacked bar would
// double-count. Separate bars on a shared baseline render the nesting
// honestly (7d sits inside 30d sits inside 1y).
//
// `ActivityBucket` is shared with ActivityStatusDonut and re-exported here
// so a future swap can import either component without a separate type.

import { computed } from 'vue';
import type { ActivityBucket } from './ActivityStatusDonut.vue';

export type { ActivityBucket };

const props = withDefaults(
  defineProps<{
    buckets: ActivityBucket[];
    barHeight?: number;
    barGap?: number;
    labelWidth?: number;
    countWidth?: number;
  }>(),
  {
    barHeight: 28,
    barGap: 12,
    labelWidth: 48,
    countWidth: 56,
  },
);

// Bars are sized to the LARGEST bucket count, not an external total. With
// cumulative buckets the widest range (1y) is the max, so it hits 100% and
// shorter ranges fill less. All-zero guards against division by zero.
const maxCount = computed(() => {
  if (props.buckets.length === 0) return 0;
  return Math.max(...props.buckets.map((b) => b.count));
});

function widthPercent(count: number): string {
  if (maxCount.value === 0) return '0%';
  return `${(count / maxCount.value) * 100}%`;
}

// Strip the "Active · " prefix — per-row rendering already implies
// activity, so the suffix ("7d", "30d", "1y") is the load-bearing part.
function shortLabel(raw: string): string {
  return raw.replace(/^Active\s*·\s*/i, '');
}
</script>

<template>
  <div class="w-full">
    <div
      v-for="(b, i) in buckets"
      :key="b.label"
      class="flex items-center gap-3"
      :style="{ marginBottom: i < buckets.length - 1 ? `${barGap}px` : '0' }"
      :data-bucket="b.label"
    >
      <div
        class="shrink-0 text-right text-xs font-medium uppercase tracking-wider text-slate-500"
        :style="{ width: `${labelWidth}px` }"
      >
        {{ shortLabel(b.label) }}
      </div>
      <div class="flex-1 overflow-hidden rounded-md bg-slate-100" :style="{ height: `${barHeight}px` }">
        <div
          class="h-full rounded-md transition-[width] duration-200"
          :style="{ width: widthPercent(b.count), backgroundColor: b.color }"
          :title="`${b.label}: ${b.count}`"
          :data-width-percent="widthPercent(b.count)"
        />
      </div>
      <div
        class="shrink-0 text-right text-sm font-semibold tabular-nums text-slate-900"
        :style="{ width: `${countWidth}px` }"
      >
        {{ b.count }}
      </div>
    </div>
  </div>
</template>
