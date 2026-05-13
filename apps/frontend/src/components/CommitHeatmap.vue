<script setup lang="ts">
// GitHub-style year contribution heatmap. Renders a 53-column × 7-row SVG
// grid of dots covering the rolling 365 days through today. Color buckets
// auto-calibrate to the data's max so the chart "fits" the entity it's
// describing — a quiet user's 4-commit day looks as dark as a prolific
// user's 40-commit day relative to their own range.
//
// SVG (not canvas) keeps each cell's <title> as a free hover tooltip with
// no per-cell JS, gets screen-reader semantics, and stays trivially
// inspectable in devtools. ~371 cells is a non-issue for the DOM.

import { computed } from 'vue';

interface DailyCommit {
  date: string; // ISO YYYY-MM-DD
  commits: number;
}

const props = defineProps<{
  data: DailyCommit[];
}>();

// Layout — sized so the chart plus the summary sidebar fits inside
// max-w-6xl without forcing a horizontal scroll on the chart column.
// Numbers are SVG user-units. Cell pitch is ~18% larger than GitHub's
// stock size, which is plenty visible without crowding the sidebar.
const CELL = 12;
const GAP = 4;
const STEP = CELL + GAP; // pitch from one cell's top-left to the next
const COLS = 53;
const ROWS = 7;
const LEFT_PAD = 24; // weekday labels
const TOP_PAD = 14; // month labels
const WIDTH = LEFT_PAD + COLS * STEP - GAP;
const HEIGHT = TOP_PAD + ROWS * STEP - GAP;

// Blue intensity ramp from neutral gray (empty) through Tailwind's
// blue-200 / 400 / 600 / 800. Steps are roughly equal-perceptual so the
// busiest days are clearly the darkest.
const PALETTE = ['#ebedf0', '#bfdbfe', '#60a5fa', '#2563eb', '#1e40af'] as const;

// `current_date - 364` on the backend → 365 days inclusive of today. The
// grid is 53 columns × 7 rows = 371 cells, so 6 cells fall outside the data
// window; those render as the empty-bucket color same as legitimate
// zero-commit days inside the window. Same color, no extra branching.

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
  // Quartile-style auto-calibration on the current data's max.
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
  // SVG coords of the rect's top-left.
  x: number;
  y: number;
  // Cells outside the rolling-365 window get a dimmer empty-bucket render
  // so it's clear the grid isn't claiming "zero commits" there.
  inWindow: boolean;
  // Future cells (after today within this week) are entirely hidden.
  visible: boolean;
}

const cells = computed<Cell[]>(() => {
  const out: Cell[] = [];
  const map = byDate.value;
  // 365-day window inclusive of today; corresponds to `current_date - 364`
  // on the backend.
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
        fill: PALETTE[fillIndex]!,
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

// Weekday labels — Mon/Wed/Fri only, matching GitHub. Cleaner axis than
// labeling all seven rows.
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

// Heatmap-specific summary stats shown in the sidebar. Total commits is
// intentionally left out — both detail pages already surface that via a
// StatCard above. These three (peak, active days, longest streak) are
// unique to this view and read naturally from the same data we just
// rendered.

const peak = computed<{ commits: number; date: string | null }>(() => {
  let best: { commits: number; date: string | null } = { commits: 0, date: null };
  for (const d of props.data) {
    if (d.commits > best.commits) best = { commits: d.commits, date: d.date };
  }
  return best;
});

const peakDateLabel = computed(() => {
  if (peak.value.date === null) return '';
  // Parse the ISO string as a local date (split avoids the TZ shift you get
  // from `new Date('YYYY-MM-DD')` interpreting it as UTC midnight).
  const [y, m, d] = peak.value.date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
});

const activeDays = computed(() => props.data.filter((d) => d.commits > 0).length);

// Longest consecutive run of commit-days within the rolling 365 window.
// Walks the window day-by-day (366 iterations max) — cheap.
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
      <!-- Heatmap-only summary on the left. Total commits is intentionally
           omitted — StatCards above the heatmap already cover that. These
           three metrics read directly off the rendered grid and add info
           that the cards don't surface. -->
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

      <!-- Chart column. Scrolls horizontally if the viewport is too narrow
           to fit the natural SVG width; on lg+ `justify-between` on the
           outer flex pushes it to the right edge so the gap between
           sidebar and chart absorbs any leftover panel width. `lg:pr-2`
           mirrors the sidebar's `lg:pl-2` so the chart's right edge sits
           the same distance from the panel border as the stats' left edge. -->
      <div class="min-w-0 overflow-x-auto lg:pr-2">
        <svg
          :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
          :width="WIDTH"
          :height="HEIGHT"
          role="img"
          :aria-label="`Daily commit counts for the past 365 days (peak ${max} commits in a single day)`"
        >
          <!-- Month axis -->
          <g class="fill-slate-500 text-[10px]">
            <text v-for="m in monthLabels" :key="`m-${m.x}`" :x="m.x" :y="10">{{ m.label }}</text>
          </g>

          <!-- Weekday axis -->
          <g class="fill-slate-500 text-[10px]">
            <text v-for="w in weekdayLabels" :key="`w-${w.label}`" :x="0" :y="w.y">{{ w.label }}</text>
          </g>

          <!-- Cells -->
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

        <!-- Legend -->
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
