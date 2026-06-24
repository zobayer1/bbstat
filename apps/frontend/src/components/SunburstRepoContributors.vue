<script setup lang="ts">
// Exploded sunburst pie for the Projects page.
//
//   - Angular wedges = top-N repos by commits in the window.
//   - Radial bands within a wedge = top contributors, thickness ∝ their share
//     of the repo's commits, together spanning [innerRadius, outerRadius].
//   - Band order is shuffled (seeded on fullName, so stable across renders)
//     so thick arcs aren't pinned to centre/perimeter and the chart reads as
//     a mosaic rather than a sorted gradient.
//   - Wedges are "exploded" outward ∝ share so the heaviest repos burst.

import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { RepoContributorBreakdown } from '@/api/client';

const props = withDefaults(
  defineProps<{
    data: RepoContributorBreakdown[];
    outerRadius?: number;
    innerRadius?: number;
  }>(),
  {
    outerRadius: 240,
    // Sized to host the 3-line centre label (window · "COMMITS" · total)
    // while still leaving a chunky annulus, not a thin rim.
    innerRadius: 50,
  },
);

// Gap (SVG units) between consecutive radial bands in a wedge; bands shrink to
// make room — see `bandWidth` derivation below.
const BAND_GAP = 6;

const emit = defineEmits<{
  'repo-click': [fullName: string];
}>();

// Palette assigned by PROJECT (not per-wedge index) so repos in the same
// project share a base colour and the chart reads as project clusters; bands
// within a wedge tint that base colour.
const PROJECT_COLORS = [
  '#06b6d4', // cyan-500
  '#a855f7', // purple-500
  '#10b981', // emerald-500
  '#f97316', // orange-500
  '#ec4899', // pink-500
  '#3b82f6', // blue-500
  '#facc15', // yellow-400
  '#14b8a6', // teal-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#84cc16', // lime-500
  '#f43f5e', // rose-500
  '#0ea5e9', // sky-500
  '#d946ef', // fuchsia-500
  '#22c55e', // green-500
  '#eab308', // yellow-500
] as const;
// Sentinel + colour for repos without a project assignment.
const UNASSIGNED_KEY = '__unassigned__';
const UNASSIGNED_COLOR = '#94a3b8'; // slate-400

const MAX_EXPLODE = 12;
const size = computed(() => (props.outerRadius + MAX_EXPLODE) * 2);
const cx = computed(() => size.value / 2);
const cy = computed(() => size.value / 2);
const totalCommits = computed(() => props.data.reduce((s, r) => s + r.commits, 0));

// Project key → palette color, assigned in descending-commit-volume order so
// the busiest project lands on the first slot. "Unassigned" always uses the
// slate sentinel regardless of its volume rank.
interface ProjectLegendEntry {
  key: string;
  label: string;
  color: string;
  commits: number;
  repoCount: number;
}
const projectLegend = computed<ProjectLegendEntry[]>(() => {
  const buckets = new Map<string, { commits: number; repoCount: number; isUnassigned: boolean }>();
  for (const repo of props.data) {
    const key = repo.project ?? UNASSIGNED_KEY;
    const cur = buckets.get(key) ?? { commits: 0, repoCount: 0, isUnassigned: repo.project === null };
    cur.commits += repo.commits;
    cur.repoCount += 1;
    buckets.set(key, cur);
  }
  const entries = Array.from(buckets, ([key, v]) => ({
    key,
    label: v.isUnassigned ? 'Unassigned' : key,
    commits: v.commits,
    repoCount: v.repoCount,
    isUnassigned: v.isUnassigned,
  })).sort((a, b) => b.commits - a.commits);
  // Reserve palette slots only for assigned projects so slot 0 always belongs
  // to a real project.
  let paletteIdx = 0;
  return entries.map((e) => ({
    key: e.key,
    label: e.label,
    color: e.isUnassigned ? UNASSIGNED_COLOR : PROJECT_COLORS[paletteIdx++ % PROJECT_COLORS.length]!,
    commits: e.commits,
    repoCount: e.repoCount,
  }));
});
const projectColor = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {};
  for (const p of projectLegend.value) m[p.key] = p.color;
  return m;
});

// Deterministic shuffle keyed on fullName so band order is stable across
// renders (no jitter) but still varies between repos.
function seededHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function shuffledIndices(seed: string, n: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let h = seededHash(seed);
  for (let i = n - 1; i > 0; i--) {
    h = (Math.imul(h, 48271) + 1) >>> 0;
    const j = h % (i + 1);
    [idx[i]!, idx[j]!] = [idx[j]!, idx[i]!];
  }
  return idx;
}

function explodeFor(share: number): number {
  if (share >= 0.25) return MAX_EXPLODE;
  if (share >= 0.15) return MAX_EXPLODE * 0.7;
  if (share >= 0.08) return MAX_EXPLODE * 0.4;
  return MAX_EXPLODE * 0.15;
}

interface Band {
  path: string;
  fill: string;
  fullName: string;
  repoSlug: string;
  contributor: string;
  commits: number;
}

interface Wedge {
  fullName: string;
  slug: string;
  project: string | null;
  commits: number;
  startAngle: number;
  endAngle: number;
  fill: string;
  explode: number;
  bands: Band[];
}

// Annulus-segment path with a radial explode offset on both endpoints.
function arcPath(startAngle: number, endAngle: number, rInner: number, rOuter: number, explode: number): string {
  const mid = (startAngle + endAngle) / 2 - Math.PI / 2;
  const ox = explode * Math.cos(mid);
  const oy = explode * Math.sin(mid);
  const a0 = startAngle - Math.PI / 2;
  const a1 = endAngle - Math.PI / 2;
  const xo0 = cx.value + ox + rOuter * Math.cos(a0);
  const yo0 = cy.value + oy + rOuter * Math.sin(a0);
  const xo1 = cx.value + ox + rOuter * Math.cos(a1);
  const yo1 = cy.value + oy + rOuter * Math.sin(a1);
  const xi0 = cx.value + ox + rInner * Math.cos(a0);
  const yi0 = cy.value + oy + rInner * Math.sin(a0);
  const xi1 = cx.value + ox + rInner * Math.cos(a1);
  const yi1 = cy.value + oy + rInner * Math.sin(a1);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M ${xo0.toFixed(2)} ${yo0.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${xo1.toFixed(2)} ${yo1.toFixed(2)}`,
    `L ${xi1.toFixed(2)} ${yi1.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${xi0.toFixed(2)} ${yi0.toFixed(2)}`,
    'Z',
  ].join(' ');
}

// Mix a base hex color toward white by `t` (0 = base, 1 = white), so adjacent
// bands sharing a wedge's family colour stay distinguishable.
function tint(hex: string, t: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

const wedges = computed<Wedge[]>(() => {
  const t = totalCommits.value;
  if (t <= 0) return [];
  let cursor = 0;
  return props.data.map((repo) => {
    const share = repo.commits / t;
    const sweep = share * Math.PI * 2;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle;
    const fill = projectColor.value[repo.project ?? UNASSIGNED_KEY] ?? UNASSIGNED_COLOR;
    // Contributors arrive sorted by commits desc; the shuffle lets the
    // thickest band land anywhere in the wedge.
    const order = shuffledIndices(repo.fullName, repo.contributors.length);
    const repoTotal = repo.contributors.reduce((s, c) => s + c.commits, 0);
    const rRange = props.outerRadius - props.innerRadius;
    // Reserve (n-1)*BAND_GAP of the radial range for inter-band gaps; bands
    // shrink proportionally, the gap is constant.
    const bandSpace = Math.max(0, rRange - Math.max(0, order.length - 1) * BAND_GAP);
    let rCursor = props.innerRadius;
    const explode = explodeFor(share);
    const bands: Band[] = [];
    for (let pos = 0; pos < order.length; pos++) {
      const cIdx = order[pos]!;
      const c = repo.contributors[cIdx]!;
      const bandShare = repoTotal > 0 ? c.commits / repoTotal : 0;
      const bandWidth = bandSpace * bandShare;
      // Tint by display position so adjacent bands alternate lighter/darker.
      const tintAmount = 0.05 + (pos % 3) * 0.18;
      const safeEnd = endAngle - startAngle >= Math.PI * 2 ? endAngle - 0.0001 : endAngle;
      bands.push({
        path: arcPath(startAngle, safeEnd, rCursor, rCursor + bandWidth, explode),
        fill: tint(fill, tintAmount),
        fullName: repo.fullName,
        repoSlug: repo.slug,
        contributor: c.displayName,
        commits: c.commits,
      });
      // No gap after the last band so the outermost band can reach outerRadius.
      rCursor += bandWidth + (pos < order.length - 1 ? BAND_GAP : 0);
    }
    return {
      fullName: repo.fullName,
      slug: repo.slug,
      project: repo.project,
      commits: repo.commits,
      startAngle,
      endAngle,
      fill,
      explode,
      bands,
    };
  });
});

const pct = (n: number): string => (totalCommits.value > 0 ? `${Math.round((n / totalCommits.value) * 100)}%` : '0%');

// Split client-side into exactly two rows; `flex-wrap` alone would let the row
// count drift with container width, but the design pins it to 2.
const legendRows = computed<ProjectLegendEntry[][]>(() => {
  const items = projectLegend.value;
  if (items.length === 0) return [[]];
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
});
</script>

<template>
  <!-- The SVG already carries MAX_EXPLODE whitespace around its edge, so the
       tight gap keeps the legend close without the two actually touching. -->
  <div class="flex flex-col items-center gap-1">
    <svg
      :width="size"
      :height="size"
      :viewBox="`0 0 ${size} ${size}`"
      role="img"
      aria-label="Repository commit share with contributor breakdown"
      class="max-w-full"
    >
      <circle
        v-if="wedges.length === 0"
        :cx="cx"
        :cy="cy"
        :r="(outerRadius + innerRadius) / 2"
        fill="none"
        stroke="#e2e8f0"
        :stroke-width="outerRadius - innerRadius"
      />
      <g v-for="w in wedges" :key="w.fullName">
        <path
          v-for="(band, bi) in w.bands"
          :key="`${w.fullName}-${bi}`"
          :d="band.path"
          :fill="band.fill"
          stroke="white"
          stroke-width="0.5"
          class="cursor-pointer transition-opacity hover:opacity-80"
          @click="emit('repo-click', w.fullName)"
        >
          <title>{{ band.repoSlug }} · {{ band.contributor }} · {{ band.commits }} commits</title>
        </path>
      </g>
      <!-- Three-line centre stack; y positions hand-tuned against innerRadius=50. -->
      <text :x="cx" :y="cy - 22" text-anchor="middle" class="fill-slate-400" style="font-size: 11px">30d</text>
      <text
        :x="cx"
        :y="cy - 6"
        text-anchor="middle"
        class="fill-slate-400"
        style="font-size: 11px; letter-spacing: 0.08em"
      >
        COMMITS
      </text>
      <text :x="cx" :y="cy + 20" text-anchor="middle" class="fill-slate-900" style="font-size: 22px; font-weight: 600">
        {{ totalCommits }}
      </text>
    </svg>

    <!-- Each row centres its own pills, so an uneven split (5 / 4) still reads
         as balanced. -->
    <div class="flex flex-col gap-2">
      <ul
        v-for="(row, rowIdx) in legendRows"
        :key="rowIdx"
        class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs"
      >
        <li v-if="row.length === 0 && rowIdx === 0" class="text-slate-400">No commits in range.</li>
        <li v-for="p in row" :key="p.key" class="flex items-center gap-1.5">
          <span
            class="inline-block size-2.5 shrink-0 rounded-sm"
            :style="{ backgroundColor: p.color }"
            aria-hidden="true"
          />
          <RouterLink
            v-if="p.key !== UNASSIGNED_KEY"
            :to="{ name: 'project', params: { projectKey: p.key } }"
            class="font-medium text-slate-700 hover:text-slate-900"
            :title="`${p.label} — ${p.repoCount} repo${p.repoCount === 1 ? '' : 's'} · ${p.commits} commits (${pct(p.commits)})`"
          >
            {{ p.label }}
          </RouterLink>
          <span v-else class="italic text-slate-500">{{ p.label }}</span>
          <span class="tabular-nums text-slate-400">{{ p.commits }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
