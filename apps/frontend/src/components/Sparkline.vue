<script setup lang="ts">
// Inline-SVG sparkline. No chart library — we just need a 30-point line for
// per-user 7d/30d activity rows on the dashboard. `points` is oldest-first
// (the shape /api/stats/top-contributors returns directly).

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    points: number[];
    width?: number;
    height?: number;
    stroke?: string;
  }>(),
  {
    width: 80,
    height: 20,
    stroke: 'currentColor',
  },
);

const max = computed(() => Math.max(...props.points, 1));

// With < 2 points there's no line to draw; skip.
const path = computed(() => {
  if (props.points.length < 2) return '';
  const xStep = props.width / (props.points.length - 1);
  return props.points
    .map((v, i) => {
      const x = i * xStep;
      const y = props.height - (v / max.value) * props.height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
});

const ariaLabel = computed(() => `${props.points.length}-day activity, peak ${max.value}`);
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    fill="none"
    role="img"
    :aria-label="ariaLabel"
    preserveAspectRatio="none"
  >
    <path :d="path" :stroke="stroke" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
