<script setup lang="ts">
// SVG Lorenz curve — cumulative share of commits (y) vs cumulative share
// of members (x), sorted ascending by commits. The y=x diagonal is the
// "perfect equality" reference: a curve hugging the diagonal means flat
// distribution, a curve bowed deeply toward the bottom-right means a
// small minority does most of the work. Gini coefficient (1 - 2*area
// under the curve) is rendered in the corner as the canonical inequality
// summary stat.
//
// Caller passes the raw per-member commit counts; the component sorts,
// normalizes, and filters zeros (members with zero commits in the active
// window don't tell us anything about concentration — including them
// would just push the curve's left tail flat and visually understate
// the inequality).

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    values: number[];
    width?: number;
    height?: number;
    // Tailwind-style hex strings so the SVG stays self-contained (no
    // dependency on inherited text color or surrounding utility classes).
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

// Inset for axis labels and tick room. Left padding fits a rotated y-axis
// title plus the 0% / 100% tick numbers; bottom padding fits the x-axis
// tick numbers plus a centered axis title underneath them. Plot rectangle
// = inner viewBox (width/height minus the four pads).
const PAD_LEFT = 46;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 42;

const plotWidth = computed(() => props.width - PAD_LEFT - PAD_RIGHT);
const plotHeight = computed(() => props.height - PAD_TOP - PAD_BOTTOM);

interface Computed {
  // Points along the Lorenz curve in plot coordinates, starting at (0,0)
  // bottom-left of the plot (oldest convention: x→members cumulative,
  // y→commits cumulative). Empty when no positive values.
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

  // Cumulative (x, y) pairs, both normalized to [0, 1]. Pre-pend the
  // origin so the path closes cleanly at the bottom-left and the area-
  // under-curve integral covers the full domain.
  const pts: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    cum += positives[i]!;
    pts.push({ x: (i + 1) / n, y: cum / total });
  }

  // Trapezoid integration over the (0..1) domain. The area between the
  // equality diagonal and the Lorenz curve is (0.5 - area_under_curve),
  // and Gini = (0.5 - area) / 0.5 = 1 - 2 * area_under_curve.
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

// Closed path for the fill — the curve plus a line back along the x-axis
// to the origin, so the shaded region is the area UNDER the Lorenz curve.
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

// Equity diagonal in plot coordinates — corner to corner of the plot
// rectangle. Rendered dashed as the "perfect equality" reference line.
const equityLine = computed(() => ({
  x1: PAD_LEFT,
  y1: PAD_TOP + plotHeight.value,
  x2: PAD_LEFT + plotWidth.value,
  y2: PAD_TOP,
}));

const giniLabel = computed(() => `Gini ${computed_.value.gini.toFixed(2)}`);

// Axis tick coordinates — single mid-axis label is enough at this size;
// 0 and 1 are implied by the corners.
const xAxisY = computed(() => PAD_TOP + plotHeight.value);
</script>

<template>
  <div>
    <!-- SVG is sized by CSS (typically `w-full` from the caller) and the
         viewBox handles the internal coordinate system. The width / height
         props now only define the viewBox / coord space, not the rendered
         size — caller controls render width via class. -->
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Commit concentration Lorenz curve"
      class="block h-auto w-full"
    >
      <!-- Plot frame -->
      <rect
        :x="PAD_LEFT"
        :y="PAD_TOP"
        :width="plotWidth"
        :height="plotHeight"
        fill="white"
        stroke="#e2e8f0"
        stroke-width="1"
      />
      <!-- Equity reference (y = x) -->
      <line
        :x1="equityLine.x1"
        :y1="equityLine.y1"
        :x2="equityLine.x2"
        :y2="equityLine.y2"
        :stroke="equityColor"
        stroke-width="1"
        stroke-dasharray="3 3"
      />
      <!-- Filled area under the curve -->
      <path v-if="computed_.hasData" :d="fillD" :fill="fillColor" />
      <!-- Curve itself -->
      <path
        v-if="computed_.hasData"
        :d="pathD"
        fill="none"
        :stroke="curveColor"
        stroke-width="1.75"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <!-- Axis tick labels — corner anchors only (0% / 100% on each axis).
           Mid-axis ticks are skipped to keep the chart uncluttered. -->
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
      <!-- Axis titles. The y-axis title is rotated -90° around its own
           anchor point so it reads bottom-to-top along the left edge. -->
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
      <!-- Gini badge (top-left of plot) -->
      <g v-if="computed_.hasData" :transform="`translate(${PAD_LEFT + 6}, ${PAD_TOP + 6})`">
        <rect width="56" height="16" rx="3" fill="#1e293b" />
        <text x="28" y="11" text-anchor="middle" class="fill-white" style="font-size: 10px; font-weight: 600">
          {{ giniLabel }}
        </text>
      </g>
      <!-- Empty-state copy -->
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
