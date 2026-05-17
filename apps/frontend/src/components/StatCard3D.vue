<script setup lang="ts">
// Dashboard stat card with a watermark SVG glyph anchored to the right
// edge and a subtle 3D hover transform. Six variants — one per dashboard
// card — keyed by `tone` (the highlight colour the glyph flips to on
// hover) and `tilt` (the rotateX/rotateY pair so each card's hover
// rotates a slightly different way; users notice the difference under
// the hood without consciously cataloguing it).
//
// When `to` is set the wrapper renders as a `<RouterLink>` so the whole
// card is clickable. When omitted it renders as a plain div with the
// hover transform still applied (consistent visual treatment across all
// six cards even when only some navigate).

import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';

type Tone = 'cyan' | 'fuchsia' | 'blue' | 'yellow' | 'green' | 'red';

const props = defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  // SVG path `d` attribute. We render the glyph inline so each card can
  // own its own shape without an icon-library dependency. Stroke-only,
  // currentColor-driven — the tone class on the SVG drives the colour.
  glyphPath: string;
  tone: Tone;
  // rotateX (positive = tip forward) / rotateY (positive = tilt right)
  // in degrees. Members card stays at +6 / -4 to match the existing
  // pattern; other cards get small unique variations.
  tilt: { x: number; y: number };
  to?: RouteLocationRaw;
}>();

// Static class lookups — Tailwind's JIT needs each class to appear as a
// literal string somewhere in the source, so we can't compose them from
// the `tone` prop at runtime via string concatenation. Keep them here.
const TONE_CLASSES: Record<Tone, string> = {
  cyan: 'text-slate-300 group-hover:text-cyan-500 group-focus-visible:text-cyan-500',
  fuchsia: 'text-slate-300 group-hover:text-fuchsia-500 group-focus-visible:text-fuchsia-500',
  blue: 'text-slate-300 group-hover:text-blue-500 group-focus-visible:text-blue-500',
  yellow: 'text-slate-300 group-hover:text-yellow-500 group-focus-visible:text-yellow-500',
  green: 'text-slate-300 group-hover:text-green-500 group-focus-visible:text-green-500',
  red: 'text-slate-300 group-hover:text-red-500 group-focus-visible:text-red-500',
};

const glyphClass = computed(() => TONE_CLASSES[props.tone]);

const hoverTransform = computed(() => {
  const { x, y } = props.tilt;
  return `translateY(-4px) scale(1.02) rotateX(${x}deg) rotateY(${y}deg)`;
});
</script>

<template>
  <component
    :is="to !== undefined ? RouterLink : 'div'"
    :to="to"
    class="group relative block rounded-lg shadow-sm transition-all duration-200 ease-out [transform-style:preserve-3d] hover:-translate-y-1 hover:scale-[1.02] hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
    :style="{ '--hover-transform': hoverTransform }"
  >
    <div class="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div class="text-sm font-medium text-slate-500">{{ label }}</div>
      <div class="mt-1 text-2xl font-semibold text-slate-900">{{ value }}</div>
      <div v-if="hint" class="mt-1 text-xs text-slate-400">{{ hint }}</div>
    </div>
    <svg
      :class="['pointer-events-none absolute top-1/2 right-4 size-14 -translate-y-1/2 transition-colors', glyphClass]"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path stroke-linecap="round" stroke-linejoin="round" :d="glyphPath" />
    </svg>
  </component>
</template>

<style scoped>
/* Per-card tilt drives a CSS custom property so each instance hovers
   with its own rotateX/rotateY pair. Defined here (scoped) instead of
   as an inline `:style="{ transform: hoverTransform }"` because the
   transform is on `:hover`, not at rest — Vue's `:style` would clobber
   the base transform, while a CSS variable lets the cascade apply only
   when hover matches. */
.group:hover {
  transform: var(--hover-transform);
}
.group:focus-visible {
  transform: var(--hover-transform);
}
</style>
