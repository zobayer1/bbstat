<script setup lang="ts">
// SVG Lorenz curve — cumulative share of commits (y) vs members (x). The y=x
// diagonal is "perfect equality"; a curve bowed toward the bottom-right means
// a small minority does most of the work. Gini (1 - 2*area under curve) is
// shown in the corner.
//
// The component sorts, normalizes, and filters zeros — members with zero
// commits in the window say nothing about concentration and including them
// would flatten the left tail and understate the inequality.

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    values: number[];
    width?: number;
    height?: number;
    // Explicit hex strings keep the SVG self-contained (no dependency on
    // inherited text color or surrounding utility classes).
    curveColor?: string;
    fillColor?: string;
    equityColor?: string;
  }>(),
  {
    width: 280,
    height: 180,
    // blue-600 / blue-500 @ 20% / slate-300
    curveColor: '#2563eb',
    fillColor: 'rgba(59, 130, 246, 0.18)',
    equityColor: '#cbd5e1',
  },
);

// Inset for axis labels and ticks. Left fits the rotated y-axis title + tick
// numbers; bottom fits the x-axis ticks + centered title. Plot rect = viewBox
// minus the four pads.
const PAD_LEFT = 46;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 42;

const plotWidth = computed(() => props.width - PAD_LEFT - PAD_RIGHT);
const plotHeight = computed(() => props.height - PAD_TOP - PAD_BOTTOM);

interface Computed {
  // Lorenz-curve points in plot coordinates, starting at the bottom-left
  // origin. Empty when no positive values.
  points: Array<{ x: number; y: number }>;
  gini: number;
  hasData: boolean;
}

const computed_ = computed<Computed>(() => {
  const positives = props.values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = positives.length;
  const total = positives.reduce((s, v) => s + v, 0);
  if (n === 0 || total === 0) {
    return { points: [], gini: 0, hasData: false };
  }

  // Cumulative (x, y) pairs normalized to [0, 1]. Prepend the origin so the
  // path closes cleanly and the integral covers the full domain.
  const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    cum += positives[i]!;
    pts.push({ x: (i + 1) / n, y: cum / total });
  }

  // Trapezoid integration over [0,1]. Gini = (0.5 - area) / 0.5 = 1 - 2*area.
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    area += ((a.y + b.y) / 2) * (b.x - a.x);
  }
  const gini = Math.max(0, Math.min(1, 1 - 2 * area));

  return {
    points: pts.map((p) => ({
      x: PAD_LEFT + p.x * plotWidth.value,
      y: PAD_TOP + (1 - p.y) * plotHeight.value,
    })),
    gini,
    hasData: true,
  };
});

const pathD = computed(() => {
  const { points, hasData } = computed_.value;
  if (!hasData) return '';
  const moves = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  return moves.join(' ');
});

// Closed path for the fill: the curve plus a line back along the x-axis to
// the origin, so the shaded region is the area under the curve.
const fillD = computed(() => {
  const { points, hasData } = computed_.value;
  if (!hasData) return '';
  const moves = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  const last = points[points.length - 1]!;
  moves.push(`L ${last.x.toFixed(2)} ${(PAD_TOP + plotHeight.value).toFixed(2)}`);
  moves.push(`L ${PAD_LEFT} ${(PAD_TOP + plotHeight.value).toFixed(2)}`);
  moves.push('Z');
  return moves.join(' ');
});

// Equity diagonal — corner to corner of the plot, the dashed "perfect
// equality" reference line.
const equityLine = computed(() => ({
  x1: PAD_LEFT,
  y1: PAD_TOP + plotHeight.value,
  x2: PAD_LEFT + plotWidth.value,
  y2: PAD_TOP,
}));

const giniLabel = computed(() => `Gini ${computed_.value.gini.toFixed(2)}`);

const xAxisY = computed(() => PAD_TOP + plotHeight.value);
</script>

<template>
  <div>
    <!-- The width / height props define only the viewBox coordinate space;
         the caller controls rendered size via class (typically `w-full`). -->
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Commit concentration Lorenz curve"
      class="block h-auto w-full"
    >
      <rect
        :x="PAD_LEFT"
        :y="PAD_TOP"
        :width="plotWidth"
        :height="plotHeight"
        fill="white"
        stroke="#e2e8f0"
        stroke-width="1"
      />
      <line
        :x1="equityLine.x1"
        :y1="equityLine.y1"
        :x2="equityLine.x2"
        :y2="equityLine.y2"
        :stroke="equityColor"
        stroke-width="1"
        stroke-dasharray="3 3"
      />
      <path v-if="computed_.hasData" :d="fillD" :fill="fillColor" />
      <path
        v-if="computed_.hasData"
        :d="pathD"
        fill="none"
        :stroke="curveColor"
        stroke-width="1.75"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <!-- Corner ticks only (0% / 100% on each axis). -->
      <text :x="PAD_LEFT" :y="xAxisY + 14" class="fill-slate-400" style="font-size: 10px">0%</text>
      <text :x="PAD_LEFT + plotWidth" :y="xAxisY + 14" text-anchor="end" class="fill-slate-400" style="font-size: 10px">
        100%
      </text>
      <text
        :x="PAD_LEFT - 4"
        :y="PAD_TOP + plotHeight + 3"
        text-anchor="end"
        class="fill-slate-400"
        style="font-size: 10px"
      >
        0%
      </text>
      <text :x="PAD_LEFT - 4" :y="PAD_TOP + 8" text-anchor="end" class="fill-slate-400" style="font-size: 10px">
        100%
      </text>
      <!-- y-axis title is rotated -90° so it reads bottom-to-top. -->
      <text
        :x="PAD_LEFT + plotWidth / 2"
        :y="xAxisY + 32"
        text-anchor="middle"
        class="fill-slate-500"
        style="font-size: 11px; font-weight: 500"
      >
        Members (cumulative)
      </text>
      <text
        :x="14"
        :y="PAD_TOP + plotHeight / 2"
        text-anchor="middle"
        :transform="`rotate(-90, 14, ${PAD_TOP + plotHeight / 2})`"
        class="fill-slate-500"
        style="font-size: 11px; font-weight: 500"
      >
        Commits (cumulative)
      </text>
      <g v-if="computed_.hasData" :transform="`translate(${PAD_LEFT + 6}, ${PAD_TOP + 6})`">
        <rect width="56" height="16" rx="3" fill="#1e293b" />
        <text x="28" y="11" text-anchor="middle" class="fill-white" style="font-size: 10px; font-weight: 600">
          {{ giniLabel }}
        </text>
      </g>
      <text
        v-else
        :x="PAD_LEFT + plotWidth / 2"
        :y="PAD_TOP + plotHeight / 2"
        text-anchor="middle"
        class="fill-slate-400"
        style="font-size: 11px"
      >
        No commits in window
      </text>
    </svg>
  </div>
</template>
