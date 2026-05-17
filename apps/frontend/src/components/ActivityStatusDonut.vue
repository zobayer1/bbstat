<script setup lang="ts">
// SVG donut chart for member-activity recency. Caller passes buckets in
// render order (most-active first reads best clockwise from 12 o'clock).
// Dumb component — no slicing logic lives here, just the geometry.
//
// `color` is any CSS color string. Inline-SVG so it inherits CSS pixel
// density and stays crisp at any container size.

import { computed } from 'vue';

export interface ActivityBucket {
  label: string;
  count: number;
  // Hex / rgb / Tailwind-generated color string. Kept verbatim and used
  // for both the donut slice fill and the legend swatch.
  color: string;
}

const props = withDefaults(
  defineProps<{
    buckets: ActivityBucket[];
    // Outer/inner radius in SVG units. Total SVG canvas is 2*outer.
    outerRadius?: number;
    innerRadius?: number;
    // Optional overline shown above the centered total — e.g. "MEMBERS".
    centerLabel?: string;
    // Where the legend sits relative to the donut. `right` (default)
    // keeps the historical side-by-side layout; `left` flips them so
    // the legend leads (handy for left-anchored panels where the
    // labels read first); `below` stacks the donut over the legend
    // for narrow columns.
    legendPosition?: 'left' | 'right' | 'below';
    // Toggle the trailing percentage column in each legend row.
    // Default `true` keeps the existing display; set `false` to
    // shrink the legend to swatch + label + count when percentages
    // would crowd a narrow layout.
    showPercent?: boolean;
    // Apply a subtle 3D presentation: the donut tilts back via CSS
    // perspective, a soft drop-shadow grounds it, and each slice
    // carries a radial gloss highlight so the surface reads as a
    // physical disc rather than a flat chart. Opt-in (default
    // false) so callers like Members.vue stay flat.
    tilt3d?: boolean;
  }>(),
  {
    outerRadius: 64,
    innerRadius: 40,
    centerLabel: '',
    legendPosition: 'right',
    showPercent: true,
    tilt3d: false,
  },
);

const total = computed(() => props.buckets.reduce((sum, b) => sum + b.count, 0));
const size = computed(() => props.outerRadius * 2);
const cx = computed(() => props.outerRadius);
const cy = computed(() => props.outerRadius);

interface Slice {
  bucket: ActivityBucket;
  path: string;
  startAngle: number;
  endAngle: number;
}

// SVG path for an annulus segment: outer arc clockwise, line to inner
// edge, inner arc counter-clockwise, close. Angle 0 = 12 o'clock,
// growing clockwise (so we negate the standard math convention).
function arcPath(startAngle: number, endAngle: number): string {
  const ri = props.innerRadius;
  const ro = props.outerRadius;
  // Convert (12-o'clock-zero, clockwise) → (3-o'clock-zero, counter-clockwise)
  // by subtracting from π/2 — both endpoints, same offset.
  const a0 = startAngle - Math.PI / 2;
  const a1 = endAngle - Math.PI / 2;
  const xOuter0 = cx.value + ro * Math.cos(a0);
  const yOuter0 = cy.value + ro * Math.sin(a0);
  const xOuter1 = cx.value + ro * Math.cos(a1);
  const yOuter1 = cy.value + ro * Math.sin(a1);
  const xInner0 = cx.value + ri * Math.cos(a0);
  const yInner0 = cy.value + ri * Math.sin(a0);
  const xInner1 = cx.value + ri * Math.cos(a1);
  const yInner1 = cy.value + ri * Math.sin(a1);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${xOuter0.toFixed(2)} ${yOuter0.toFixed(2)}`,
    `A ${ro} ${ro} 0 ${largeArc} 1 ${xOuter1.toFixed(2)} ${yOuter1.toFixed(2)}`,
    `L ${xInner1.toFixed(2)} ${yInner1.toFixed(2)}`,
    `A ${ri} ${ri} 0 ${largeArc} 0 ${xInner0.toFixed(2)} ${yInner0.toFixed(2)}`,
    'Z',
  ].join(' ');
}

const slices = computed<Slice[]>(() => {
  const t = total.value;
  if (t <= 0) return [];
  let cursor = 0;
  return props.buckets
    .filter((b) => b.count > 0)
    .map((bucket) => {
      const sweep = (bucket.count / t) * Math.PI * 2;
      const startAngle = cursor;
      const endAngle = cursor + sweep;
      cursor = endAngle;
      // 360° single-bucket edge case — SVG can't draw a full arc from a
      // point back to itself, so nudge the end angle by an imperceptible
      // epsilon. The visible result is a complete annulus.
      const safeEnd = endAngle - startAngle >= Math.PI * 2 ? endAngle - 0.0001 : endAngle;
      return { bucket, path: arcPath(startAngle, safeEnd), startAngle, endAngle };
    });
});

const pct = (count: number): string => {
  const t = total.value;
  if (t <= 0) return '0%';
  return `${Math.round((count / t) * 100)}%`;
};

// Full-annulus path used as a gloss overlay when tilt3d is on.
// Two subpaths (outer then inner) combined with fill-rule="evenodd"
// punches the hole through the disc so the gradient only paints the
// donut surface, not the centre.
const annulusPath = computed(() => {
  const ro = props.outerRadius;
  const ri = props.innerRadius;
  const cxv = cx.value;
  const cyv = cy.value;
  return [
    `M ${cxv} ${cyv - ro}`,
    `A ${ro} ${ro} 0 1 1 ${cxv} ${cyv + ro}`,
    `A ${ro} ${ro} 0 1 1 ${cxv} ${cyv - ro}`,
    'Z',
    `M ${cxv} ${cyv - ri}`,
    `A ${ri} ${ri} 0 1 0 ${cxv} ${cyv + ri}`,
    `A ${ri} ${ri} 0 1 0 ${cxv} ${cyv - ri}`,
    'Z',
  ].join(' ');
});

// Unique gradient id per instance so two donuts on the same page
// don't share `<defs>` IDs and clobber each other's gloss overlay.
const glossId = `donut-gloss-${Math.random().toString(36).slice(2, 10)}`;
</script>

<template>
  <div
    :class="[
      'flex',
      legendPosition === 'below' ? 'flex-col items-center gap-4' : 'items-center',
      legendPosition === 'left' ? 'flex-row-reverse justify-end gap-4' : '',
      legendPosition === 'right' ? 'gap-8' : '',
    ]"
  >
    <svg
      :width="size"
      :height="size"
      :viewBox="`0 0 ${size} ${size}`"
      role="img"
      aria-label="Member activity status"
      :class="['shrink-0', tilt3d ? 'donut-tilt' : '']"
    >
      <defs v-if="tilt3d">
        <!-- Top-down highlight: brighter near 12 o'clock, fading to
             transparent past the equator. Acts as overhead lighting
             so the tilted disc reads as a physical surface. -->
        <radialGradient :id="glossId" cx="50%" cy="25%" r="65%">
          <stop offset="0%" stop-color="white" stop-opacity="0.45" />
          <stop offset="55%" stop-color="white" stop-opacity="0.08" />
          <stop offset="100%" stop-color="white" stop-opacity="0" />
        </radialGradient>
      </defs>
      <!-- Empty-state ring — drawn when total = 0 so the donut placeholder
           still has visual mass instead of disappearing. -->
      <circle
        v-if="total === 0"
        :cx="cx"
        :cy="cy"
        :r="(outerRadius + innerRadius) / 2"
        fill="none"
        stroke="#e2e8f0"
        :stroke-width="outerRadius - innerRadius"
      />
      <path
        v-for="(slice, i) in slices"
        :key="i"
        :d="slice.path"
        :fill="slice.bucket.color"
        stroke="white"
        stroke-width="1"
      />
      <!-- Gloss overlay — full annulus filled with the radial gradient
           defined above. fill-rule=evenodd punches the hole so only
           the donut surface gets the highlight. -->
      <path
        v-if="tilt3d && total > 0"
        :d="annulusPath"
        :fill="`url(#${glossId})`"
        fill-rule="evenodd"
        pointer-events="none"
      />
      <!-- Type scales with outerRadius so the center stays legible at any
           caller-chosen donut size: ~10% of radius for the overline, ~28%
           for the total. -->
      <text
        v-if="centerLabel !== ''"
        :x="cx"
        :y="cy - outerRadius * 0.12"
        text-anchor="middle"
        class="fill-slate-400"
        :style="{
          fontSize: `${Math.max(10, outerRadius * 0.13)}px`,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }"
      >
        {{ centerLabel }}
      </text>
      <text
        :x="cx"
        :y="centerLabel !== '' ? cy + outerRadius * 0.18 : cy + outerRadius * 0.08"
        text-anchor="middle"
        class="fill-slate-900"
        :style="{ fontSize: `${outerRadius * 0.32}px`, fontWeight: 600 }"
      >
        {{ total }}
      </text>
    </svg>
    <!-- Legend grid. Each row contributes its swatch, label, count
         (and optional percent) as four direct grid children via
         `display: contents` on the <li>. The count column is `auto`
         (= widest count across rows) with `text-right` inside, so
         digits right-align without expanding the legend's overall
         width: the legend stays content-sized and only the count's
         own column anchors to its right edge. -->
    <ul
      :class="[
        'grid items-center gap-x-3 gap-y-2 text-sm',
        legendPosition === 'below' ? 'w-full max-w-xs' : '',
        showPercent ? 'grid-cols-[auto_auto_auto_auto]' : 'grid-cols-[auto_auto_auto]',
      ]"
    >
      <li v-for="b in buckets" :key="b.label" class="contents">
        <span class="inline-block size-3 rounded-sm" :style="{ backgroundColor: b.color }" aria-hidden="true" />
        <span class="truncate text-slate-600">{{ b.label }}</span>
        <span class="text-right tabular-nums text-slate-900">{{ b.count }}</span>
        <span v-if="showPercent" class="w-12 text-right tabular-nums text-slate-400">{{ pct(b.count) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* 3D presentation for the donut. Tilts the SVG back ~22° via CSS
   perspective so the disc reads as a tilted record on a turntable,
   and grounds it with a soft drop-shadow. The gloss highlight
   inside the SVG (radial gradient overlay) does the actual surface
   modelling — without it, the tilt alone reads as a squashed
   ellipse. Disabled under prefers-reduced-motion-style preferences
   isn't necessary here because the transform is static, not
   animated. */
.donut-tilt {
  transform: perspective(640px) rotateX(22deg);
  transform-origin: center center;
  filter: drop-shadow(0 10px 14px rgba(15, 23, 42, 0.22));
}
</style>
