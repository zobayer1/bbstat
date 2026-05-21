<script setup lang="ts">
import { computed } from 'vue';
import type { UserBadge, UserBadgeTier } from '@/api/client';

const props = defineProps<{ badge: UserBadge | null; tier?: UserBadgeTier | null }>();

// Icon-only renderer for the ShipShow Score persona badge (docs/scoring.md).
// Each badge gets a distinct shape AND distinct hue so the icon is legible
// at small sizes without relying on the tooltip; the tooltip + aria-label
// supply the human-readable explanation for accessibility and hover.
//
// Color palette is six well-separated hues from Tailwind — no two badges
// share a colour family. Shapes are single-glyph inline SVGs (no external
// icon set, to avoid pulling in a 200kb dependency for six icons).
//
// Within-persona tier (bronze/silver/gold) renders as a colored ring
// around the icon. Currently only `steady_eddie` carries a tier; other
// badges render with no ring.
//
// Slug → label mapping lives here so a rename of the visible label (e.g.
// internal `batch_betty` stays the same but the title text changes) lands
// in one place and doesn't have to grep the codebase.
type Shape = 'pulse' | 'bars' | 'arrow-down' | 'sparkle' | 'sprout' | 'broom';

const META: Record<UserBadge, { label: string; tone: string; shape: Shape; title: string }> = {
  steady_eddie: {
    label: 'Steady Eddie',
    tone: 'text-emerald-600',
    shape: 'pulse',
    title: 'Steady Eddie — consistent contributor, high regularity, frequent active days.',
  },
  batch_betty: {
    label: 'Batch Betty',
    tone: 'text-amber-500',
    shape: 'bars',
    title: 'Batch Betty — regular spacing but bursty, few active days with predictable cadence.',
  },
  deep_diver: {
    label: 'Deep Diver',
    tone: 'text-blue-600',
    shape: 'arrow-down',
    title: 'Deep Diver — large commits, infrequent activity, architectural/research pattern.',
  },
  ai_alex: {
    label: 'AI Alex',
    tone: 'text-violet-600',
    shape: 'sparkle',
    title: 'AI Alex — bimodal commit sizes, small human edits plus occasional large blobs.',
  },
  fresh_meat: {
    label: 'Fresh Meat',
    tone: 'text-pink-500',
    shape: 'sprout',
    title: 'Fresh Meat — new joiner, under 14 days since first commit.',
  },
  cleanup_crew: {
    label: 'Cleanup Crew',
    tone: 'text-slate-500',
    shape: 'broom',
    title: 'Cleanup Crew — net negative-line contributor, refactoring/deletion focus.',
  },
};

const meta = computed(() => (props.badge === null ? null : META[props.badge]));

// Background tint by tier — bronze / silver / gold. Replaces the default
// soft tinted-by-icon-color circle when a tier is present. The icon glyph
// keeps its persona color (meta.tone) on top, so steady_eddie still
// reads as emerald regardless of tier; the metallic halo around it
// communicates the tier on its own.
//
// Opacity tuned so the persona icon stays legible against each tier
// color: slate-400 (silver) at /30 reads cooler, yellow-500 (gold) and
// amber-700 (bronze) at /25 give a warm halo without overpowering the
// glyph.
const TIER_BG: Record<UserBadgeTier, string> = {
  bronze: 'bg-amber-700/25',
  silver: 'bg-slate-400/30',
  gold: 'bg-yellow-500/30',
};

const TIER_LABEL: Record<UserBadgeTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

// Non-tiered badges get a soft circle in their own color (the "default"
// circle so the column doesn't look ragged). Tiered badges replace it
// with the tier color so the medal reads from across the room.
const bgClass = computed(() => (props.tier ? TIER_BG[props.tier] : 'bg-current/10'));

const fullTitle = computed(() => {
  if (!meta.value) return '';
  if (!props.tier) return meta.value.title;
  return `${TIER_LABEL[props.tier]} — ${meta.value.title}`;
});

const fullAriaLabel = computed(() => {
  if (!meta.value) return '';
  if (!props.tier) return meta.value.label;
  return `${TIER_LABEL[props.tier]} ${meta.value.label}`;
});
</script>

<template>
  <span
    v-if="meta"
    :class="['inline-flex h-6 w-6 items-center justify-center rounded-full', meta.tone, bgClass]"
    :title="fullTitle"
    :aria-label="fullAriaLabel"
    role="img"
  >
    <!-- Steady Eddie — pulse / heartbeat waveform. Rhythmic peaks
         signal "regular cadence". -->
    <svg
      v-if="meta.shape === 'pulse'"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-4 w-4"
    >
      <path d="M1 8 H4 L5.5 4 L7 12 L8.5 6 L10 10 L11.5 8 H15" />
    </svg>

    <!-- Batch Betty — three stacked horizontal bars at varied lengths,
         evoking a calendar / Gantt of bursty work. -->
    <svg v-else-if="meta.shape === 'bars'" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" class="h-4 w-4">
      <rect x="3" y="3" width="10" height="2" rx="0.5" />
      <rect x="3" y="7" width="6" height="2" rx="0.5" />
      <rect x="3" y="11" width="9" height="2" rx="0.5" />
    </svg>

    <!-- Deep Diver — vertical down-arrow with a floor line. Diving deep
         into one big change. -->
    <svg
      v-else-if="meta.shape === 'arrow-down'"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-4 w-4"
    >
      <path d="M8 2 V11" />
      <path d="M4.5 7.5 L8 11 L11.5 7.5" />
      <path d="M3 14 H13" />
    </svg>

    <!-- AI Alex — 4-point sparkle plus a smaller sparkle, the universal
         "AI / magic" shorthand. -->
    <svg
      v-else-if="meta.shape === 'sparkle'"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="currentColor"
      class="h-4 w-4"
    >
      <path d="M7 1 L8.2 5.3 L12.5 6.5 L8.2 7.7 L7 12 L5.8 7.7 L1.5 6.5 L5.8 5.3 Z" />
      <path d="M12 10 L12.6 11.8 L14.4 12.4 L12.6 13 L12 14.8 L11.4 13 L9.6 12.4 L11.4 11.8 Z" />
    </svg>

    <!-- Fresh Meat — sapling / sprout, two leaves emerging from a stem.
         Universal "new growth" symbol. -->
    <svg
      v-else-if="meta.shape === 'sprout'"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-4 w-4"
    >
      <path d="M8 14 V8" />
      <path d="M8 9 C5 9 4 7 4 5 C6 5 8 6 8 9 Z" fill="currentColor" stroke="none" />
      <path d="M8 9 C11 9 12 7 12 5 C10 5 8 6 8 9 Z" fill="currentColor" stroke="none" opacity="0.55" />
    </svg>

    <!-- Cleanup Crew — broom (handle + bristles). Net deletions / janitorial
         work made visible. -->
    <svg
      v-else
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-4 w-4"
    >
      <path d="M13 2 L7 8" />
      <path d="M4 9 L9 14 L13 12 L11 7 Z" fill="currentColor" fill-opacity="0.25" />
      <path d="M5 11 L4 14" />
      <path d="M7 13 L7 15" />
      <path d="M10 13.5 L11 15" />
    </svg>
  </span>
</template>
