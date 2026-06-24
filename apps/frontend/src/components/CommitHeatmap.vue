<script setup lang="ts">
// GitHub-style year contribution heatmap: a 53×7 SVG grid over the rolling
// 365 days through today. Color buckets auto-calibrate to the data's max so a
// quiet user's 4-commit day looks as dark as a prolific user's 40-commit day
// relative to their own range.
//
// SVG (not canvas) gives each cell a free <title> tooltip and screen-reader
// semantics with no per-cell JS; ~371 cells is a non-issue for the DOM.

import { computed } from 'vue';

interface DailyCommit {
  date: string; // ISO YYYY-MM-DD
  commits: number;
}

// `scope` picks the colour palette so the three contexts (workspace-wide /
// per-user / per-repo) are distinguishable at a glance. `'global'` (blue) is
// also used by the project-detail page, a workspace-aggregate rollup.
const props = withDefaults(
  defineProps<{
    data: DailyCommit[];
    scope?: 'global' | 'user' | 'repo';
  }>(),
  { scope: 'global' },
);

// Layout in SVG user-units. Cell pitch is ~18% larger than GitHub's stock.
const CELL = 12;
const GAP = 4;
const STEP = CELL + GAP; // pitch from one cell's top-left to the next
const COLS = 53;
const ROWS = 7;
const LEFT_PAD = 24; // weekday labels
const TOP_PAD = 14; // month labels
const WIDTH = LEFT_PAD + COLS * STEP - GAP;
const HEIGHT = TOP_PAD + ROWS * STEP - GAP;

// Per-scope intensity ramp, empty → busiest. Same first slot for every scope
// so empty cells look identical across pages.
const PALETTES = {
  global: ['#ebedf0', '#bfdbfe', '#60a5fa', '#2563eb', '#1e40af'],
  user: ['#ebedf0', '#ddd6fe', '#a78bfa', '#7c3aed', '#5b21b6'],
  repo: ['#ebedf0', '#a7f3d0', '#34d399', '#059669', '#065f46'],
} as const;
const PALETTE = computed(() => PALETTES[props.scope]);

// Grid is 53×7 = 371 cells but the data window is 365 days; the 6 extra cells
// render as the empty-bucket color, same as zero-commit days inside the window.

const today = new Date();
today.setHours(0, 0, 0, 0);

// Anchor the grid so today sits in the rightmost column at its weekday row.
// Walk back (COLS - 1) weeks plus the offset from this week's Sunday so the
// leftmost-top cell lands on a Sunday.
const gridStart = (() => {
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (COLS - 1) * 7);
  return start;
})();

// O(1) lookup from `yyyy-mm-dd` → commits. Built once per `data` change.
const byDate = computed(() => new Map(props.data.map((d) => [d.date, d.commits])));

const max = computed(() => {
  let m = 0;
  for (const d of props.data) if (d.commits > m) m = d.commits;
  return m;
});

function bucket(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  // Quartile-style calibration on the current data's max.
  const q = max.value / 4;
  if (count <= q) return 1;
  if (count <= q * 2) return 2;
  if (count <= q * 3) return 3;
  return 4;
}

interface Cell {
  date: string; // ISO key
  display: string; // friendly date for tooltip
  commits: number;
  fill: string;
  x: number;
  y: number;
  // Cells outside the rolling-365 window render empty so the grid doesn't
  // claim "zero commits" there.
  inWindow: boolean;
  // Future cells (after today within this week) are entirely hidden.
  visible: boolean;
}

const cells = computed<Cell[]>(() => {
  const out: Cell[] = [];
  const map = byDate.value;
  // 365-day window inclusive of today (matches backend `current_date - 364`).
  const windowStart = new Date(today);
  windowStart.setDate(today.getDate() - 364);
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + col * 7 + row);
      const iso = isoDate(cellDate);
      const visible = cellDate <= today;
      const inWindow = cellDate >= windowStart && cellDate <= today;
      const commits = map.get(iso) ?? 0;
      const fillIndex = inWindow ? bucket(commits) : 0;
      out.push({
        date: iso,
        display: cellDate.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        commits,
        fill: PALETTE.value[fillIndex]!,
        x: LEFT_PAD + col * STEP,
        y: TOP_PAD + row * STEP,
        inWindow,
        visible,
      });
    }
  }
  return out;
});

// Month labels — one per column where the month changes between row 0 of
// this column and row 0 of the previous column.
const monthLabels = computed<Array<{ label: string; x: number }>>(() => {
  const labels: Array<{ label: string; x: number }> = [];
  let lastMonth = -1;
  for (let col = 0; col < COLS; col++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + col * 7);
    const m = d.getMonth();
    if (m !== lastMonth) {
      labels.push({
        label: d.toLocaleDateString(undefined, { month: 'short' }),
        x: LEFT_PAD + col * STEP,
      });
      lastMonth = m;
    }
  }
  return labels;
});

// Weekday labels — Mon/Wed/Fri only, matching GitHub.
const weekdayLabels: Array<{ label: string; y: number }> = [
  { label: 'Mon', y: TOP_PAD + 1 * STEP + CELL - 2 },
  { label: 'Wed', y: TOP_PAD + 3 * STEP + CELL - 2 },
  { label: 'Fri', y: TOP_PAD + 5 * STEP + CELL - 2 },
];

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tooltipText(cell: Cell): string {
  if (!cell.inWindow) return `${cell.display} · outside window`;
  if (cell.commits === 0) return `${cell.display} · no commits`;
  return `${cell.display} · ${cell.commits} commit${cell.commits === 1 ? '' : 's'}`;
}

// Sidebar summary stats. Total commits is intentionally omitted — detail
// pages surface it via a StatCard above; peak / active days / longest streak
// are unique to this view.

const peak = computed<{ commits: number; date: string | null }>(() => {
  let best: { commits: number; date: string | null } = { commits: 0, date: null };
  for (const d of props.data) {
    if (d.commits > best.commits) best = { commits: d.commits, date: d.date };
  }
  return best;
});

const peakDateLabel = computed(() => {
  if (peak.value.date === null) return '';
  // Split-parse avoids the TZ shift from `new Date('YYYY-MM-DD')` treating it
  // as UTC midnight.
  const [y, m, d] = peak.value.date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
});

const activeDays = computed(() => props.data.filter((d) => d.commits > 0).length);

// Longest consecutive run of commit-days within the rolling 365 window.
const longestStreak = computed(() => {
  const map = byDate.value;
  const start = new Date(today);
  start.setDate(today.getDate() - 364);
  let cur = 0;
  let best = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if ((map.get(isoDate(d)) ?? 0) > 0) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
});
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
      <dl class="space-y-3 text-sm lg:w-36 lg:shrink-0 lg:border-r lg:border-slate-200 lg:pl-2 lg:pr-4">
        <div>
          <dt class="text-[10px] uppercase tracking-wider text-slate-500">Peak day</dt>
          <dd class="text-base font-semibold text-slate-900">
            {{ peak.commits }}
            <span class="text-xs font-normal text-slate-500"> commit{{ peak.commits === 1 ? '' : 's' }} </span>
          </dd>
          <dd v-if="peakDateLabel" class="text-[11px] text-slate-500">{{ peakDateLabel }}</dd>
          <dd v-else class="text-[11px] text-slate-400">—</dd>
        </div>
        <div>
          <dt class="text-[10px] uppercase tracking-wider text-slate-500">Active days</dt>
          <dd class="text-base font-semibold text-slate-900">
            {{ activeDays }}
            <span class="text-xs font-normal text-slate-500">/ 365</span>
          </dd>
        </div>
        <div>
          <dt class="text-[10px] uppercase tracking-wider text-slate-500">Longest streak</dt>
          <dd class="text-base font-semibold text-slate-900">
            {{ longestStreak }}
            <span class="text-xs font-normal text-slate-500"> day{{ longestStreak === 1 ? '' : 's' }} </span>
          </dd>
        </div>
      </dl>

      <!-- Scrolls horizontally on narrow viewports. `lg:pr-2` mirrors the
           sidebar's `lg:pl-2` so both edges sit equidistant from the panel border. -->
      <div class="min-w-0 overflow-x-auto lg:pr-2">
        <svg
          :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
          :width="WIDTH"
          :height="HEIGHT"
          role="img"
          :aria-label="`Daily commit counts for the past 365 days (peak ${max} commits in a single day)`"
        >
          <g class="fill-slate-500 text-[10px]">
            <text v-for="m in monthLabels" :key="`m-${m.x}`" :x="m.x" :y="10">{{ m.label }}</text>
          </g>

          <g class="fill-slate-500 text-[10px]">
            <text v-for="w in weekdayLabels" :key="`w-${w.label}`" :x="0" :y="w.y">{{ w.label }}</text>
          </g>

          <g>
            <rect
              v-for="cell in cells"
              v-show="cell.visible"
              :key="cell.date"
              :x="cell.x"
              :y="cell.y"
              :width="CELL"
              :height="CELL"
              rx="2"
              ry="2"
              :fill="cell.fill"
            >
              <title>{{ tooltipText(cell) }}</title>
            </rect>
          </g>
        </svg>

        <div class="mt-2 flex items-center gap-2 text-[10px] text-slate-500">
          <span>Less</span>
          <span
            v-for="(swatch, i) in PALETTE"
            :key="`legend-${i}`"
            class="inline-block h-2.5 w-2.5 rounded-sm"
            :style="{ backgroundColor: swatch }"
          />
          <span>More</span>
        </div>
      </div>
    </div>
  </div>
</template>
