<script setup lang="ts">
// Active-members chart. Renders one horizontal bar per bucket, each
// sized to its own count — NOT a stacked partition. The caller
// computes the bucket counts as *cumulative ranges* ("members active
// within the last 7 / 30 / 365 days") so 7d ≤ 30d ≤ 1y by
// construction; a stacked bar would double-count under that
// semantic. With nested ranges, separate bars on a shared baseline
// is the honest shape: the 7d bar sits visually inside the 30d
// bar's length, which sits inside the 1y bar's length, and the
// emerald-shade gradient (darkest = most-active = shortest)
// reinforces the "tightening recency window" narrative.
//
// Caller-passed `ActivityBucket` shape is shared with
// ActivityStatusDonut for type-import compatibility; re-exported
// here so a future swap can import either component without picking
// up a separate type.

import { computed } from 'vue';
import type { ActivityBucket } from './ActivityStatusDonut.vue';

export type { ActivityBucket };

const props = withDefaults(
  defineProps<{
    buckets: ActivityBucket[];
    // Height of each individual bar row, in pixels. Total chart
    // height = N * barHeight + (N-1) * barGap.
    barHeight?: number;
    // Vertical gap between bar rows.
    barGap?: number;
    // Width of the left-side label column, in pixels. Right-aligned
    // so the bars start at a consistent x position.
    labelWidth?: number;
    // Width of the right-side count column, in pixels.
    countWidth?: number;
  }>(),
  {
    barHeight: 28,
    barGap: 12,
    labelWidth: 48,
    countWidth: 56,
  },
);

// Bars are sized proportionally to the LARGEST bucket count, not to
// any external total. With cumulative buckets the largest is always
// the widest range (1y), so it ends up at 100% and the shorter
// ranges fill less. When every bucket is zero (no active members at
// all), every bar renders at 0% width and the slate-track-only row
// reads as "empty bucket" without crashing on division by zero.
const maxCount = computed(() => {
  if (props.buckets.length === 0) return 0;
  return Math.max(...props.buckets.map((b) => b.count));
});

function widthPercent(count: number): string {
  if (maxCount.value === 0) return '0%';
  return `${(count / maxCount.value) * 100}%`;
}

// Strip the "Active · " prefix for the per-row label — the per-row
// rendering already implies activity, so the suffix ("7d", "30d",
// "1y") is the load-bearing part.
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
      <!-- Track + filled bar. Track stays slate-100 for the empty
           area so the eye sees how much of the max range each bucket
           covers. Filled bar uses the bucket's color. -->
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
