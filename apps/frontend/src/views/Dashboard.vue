<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import StatCard3D from '@/components/StatCard3D.vue';
import Sparkline from '@/components/Sparkline.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import ActorPicker from '@/components/ActorPicker.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import { useActorFilter } from '@/composables/useActorFilter';
import { api, type ContributorWindow } from '@/api/client';
import { liveBus } from '@/lib/live';

const stats = useStatsStore();
const route = useRoute();
const router = useRouter();

// Workspace-wide 365-day daily aggregate for the dashboard heatmap.
// Reads from /api/activity-daily with no filters so the chart is the
// org-level cadence picture. SSE-refreshes whenever a commits-tick
// lands so the most-recent day's cell fills in without a page reload.
const dailyCommits = ref<{ date: string; commits: number }[]>([]);
async function loadDailyCommits(): Promise<void> {
  try {
    dailyCommits.value = await api.activityDaily();
  } catch {
    dailyCommits.value = [];
  }
}
const liveCleanups: Array<() => void> = [];

onMounted(() => {
  void stats.fetchOverview();
  void loadDailyCommits();
  liveCleanups.push(liveBus.on('tick.commits.complete', () => void loadDailyCommits()));
  liveCleanups.push(liveBus.on('repository.deleted', () => void loadDailyCommits()));
  liveCleanups.push(liveBus.onFallback(() => void loadDailyCommits()));
});

onUnmounted(() => {
  for (const off of liveCleanups) off();
  liveCleanups.length = 0;
});

// Filter state is URL-synced (router.replace, no history entries) so deep
// links work — e.g. /?actor=42&repo=tigerit/foo lands on a pre-filtered
// view. The actor filter (user or person) is owned by useActorFilter.
const filterActor = useActorFilter();
// Project + repo share a single composable that owns the URL sync and
// the project↔repo interlock (picking a repo auto-fills its project;
// picking a project trims the repo dropdown and clears a now-mismatched
// repo). `repoOptions` is the trimmed-by-project list for the
// `<select>` below.
const {
  projectModel: filterProject,
  repoModel: filterRepo,
  repoOptions: repoFilterOptions,
} = useActivityFilters({
  repositories: computed(() => stats.repositories),
});

const filtersActive = computed(
  () => filterActor.value !== undefined || filterRepo.value !== undefined || filterProject.value !== undefined,
);

function clearFilters() {
  const next = { ...route.query };
  delete next.actor;
  delete next.actorKind;
  delete next.repo;
  delete next.project;
  void router.replace({ query: next });
}

const repos = computed(() => stats.overview?.repositories ?? '—');
const projects = computed(() => stats.overview?.projects ?? '—');
const contributors = computed(() => stats.overview?.contributors ?? '—');
const totalCommits = computed(() => stats.overview?.totalCommits ?? '—');
const commitsLast7Days = computed(() => stats.overview?.commitsLast7Days ?? '—');
const commitsLast30Days = computed(() => stats.overview?.commitsLast30Days ?? '—');

// Heroicons-outline glyph paths embedded inline so each card can own its
// own shape without an icon-library dep. Keep these near the cards
// they're used in so the visual treatment is local to the template.
const GLYPHS = {
  folder:
    'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
  rectangleStack:
    'M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122',
  users:
    'M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',
  bolt: 'm3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z',
  calendar:
    'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5',
  chartBar:
    'M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75H6A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25Z',
} as const;

// Recompute `after` boundaries every time the dashboard mounts so a stale
// tab doesn't bake in a week-old window. Format is YYYY-MM-DD (matches the
// `<input type="date">` controls on the Activity page so they hydrate
// cleanly from the URL) — Activity.vue converts to an ISO timestamp at
// request time.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceSevenDays = computed(() => localDateString(new Date(Date.now() - 7 * DAY_MS)));
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));

const windows: ContributorWindow[] = ['7d', '30d'];
const windowLabel = (w: ContributorWindow) => (w === '7d' ? 'Last 7 days' : 'Last 30 days');

// Denominator for the per-contributor share bar — total commits across the
// whole workspace in the active window. Falls back to 0 when overview hasn't
// landed yet; the bar guards with `share === 0 ? 0 : ...` so the unfilled
// track still renders cleanly.
//
// Bar metric: **log-volume** = ln(1 + additions + deletions) over the
// active 7d/30d window, normalised against the displayed group's max.
// Log compresses large differences so a 50k-churn dev doesn't dwarf a
// 500-churn dev visually while the order still reflects volume.
// Window-responsive: `additionsWindow` and `deletionsWindow` change
// when the tab toggles between 7d and 30d, so the bar moves too.
const contributorVolumeLn = (c: { additionsWindow: number; deletionsWindow: number }): number =>
  Math.log1p(c.additionsWindow + c.deletionsWindow);

const maxDisplayedVolumeLn = computed(() => {
  let max = 0;
  for (const c of stats.topContributors) {
    const v = contributorVolumeLn(c);
    if (v > max) max = v;
  }
  return max;
});

const volumeShare = (c: { additionsWindow: number; deletionsWindow: number }): number => {
  const max = maxDisplayedVolumeLn.value;
  if (max <= 0) return 0;
  return Math.min(100, (contributorVolumeLn(c) / max) * 100);
};

const tooltipMomentum = (m: number | null): string => (m === null ? '—' : m.toFixed(1));
const tooltipConsistency = (c: number | null): string => (c === null ? '—' : `${Math.round(c * 100)}%`);
// Same value that drives the bar — ln(1 + adds + dels) for the active
// window. Shown raw (not the normalised percentage) so the tooltip
// states the underlying coefficient, not its visual projection.
const tooltipVolume = (c: { additionsWindow: number; deletionsWindow: number }): string =>
  contributorVolumeLn(c).toFixed(2);

// Top Contributors + Activity share the same vertical real estate via a
// tab control. Default to Contributors per user spec; switching tabs is
// pure component state (no URL sync — filters in the URL still apply to
// the Activity tab when it's open, the tab itself doesn't need persisting).
type DashboardTab = 'contributors' | 'activity';
const activeTab = ref<DashboardTab>('contributors');
// Sized to the Top Contributors content (~10 rows × ~46px ≈ 28rem). The
// Contributors container uses `overflow-y: hidden` — a hairline overflow
// doesn't surface a scrollbar, and any future content growth (bigger
// LIMIT, longer names wrapping) gets clipped cleanly inside the box
// instead of escaping into the panels below. Activity keeps its
// `overflow-y: auto` so paging works.
const ACTIVITY_PANEL_HEIGHT = '28rem';

// Projects panel is derived from the repository list — group by project key
// (skipping repos with no project assignment), sum commits/repos, and take the
// max last-commit timestamp as the project's "last activity". Sorted by 30d
// activity desc so the most-active projects float to the top.
const projectsPanel = computed(() => {
  const buckets = new Map<string, { repoCount: number; commits30d: number; lastActivity: string | null }>();
  for (const r of stats.repositories) {
    if (r.project === null) continue;
    const cur = buckets.get(r.project) ?? { repoCount: 0, commits30d: 0, lastActivity: null };
    cur.repoCount++;
    cur.commits30d += r.commits30d;
    if (r.lastCommitAt !== null && (cur.lastActivity === null || r.lastCommitAt > cur.lastActivity)) {
      cur.lastActivity = r.lastCommitAt;
    }
    buckets.set(r.project, cur);
  }
  return Array.from(buckets, ([projectKey, b]) => ({ projectKey, ...b })).sort((a, b) => b.commits30d - a.commits30d);
});

const formatLastCommit = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString());

// Top 10 repositories by 30-day commit volume. Always-visible
// leaderboard on the dashboard — the full searchable / paginated
// repository list lives on the Projects page.
const topRepos = computed(() =>
  stats.repositories
    .slice()
    .sort((a, b) => b.commits30d - a.commits30d)
    .slice(0, 10),
);
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="relative mb-6 h-[88px] overflow-hidden rounded-lg">
      <!-- Full-width water. Two layered paths fan across any
           viewport via preserveAspectRatio="none": a higher cyan
           layer with sharply irregular peaks, and a softer sky
           layer rolling underneath. The boat + title sit over
           this background. -->
      <svg
        class="absolute inset-x-0 bottom-0 h-11 w-full"
        viewBox="0 0 1200 80"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M0 26 L60 14 L120 32 L180 12 L240 26 L300 18 L360 34 L420 14 L480 28 L540 18 L600 22 L660 32 L720 14 L780 26 L840 20 L900 32 L960 14 L1020 28 L1080 14 L1140 24 L1200 18 L1200 80 L0 80 Z"
          fill="#7dd3fc"
        />
        <path
          d="M0 48 L100 42 L200 50 L300 40 L400 48 L500 42 L600 52 L700 44 L800 50 L900 40 L1000 48 L1100 42 L1200 48 L1200 80 L0 80 Z"
          fill="#38bdf8"
          opacity="0.85"
        />
      </svg>
      <!-- Sheen sweep over the water — translucent white gradient
           translating left-to-right on a slow ease-in-out loop,
           same trick as the Repositories top-5 bar wave. Pinned to
           the water layer's bounds so it never leaks onto the boat
           or title above. Disabled under prefers-reduced-motion. -->
      <div
        class="water-sheen pointer-events-none absolute inset-x-0 bottom-0 h-11 overflow-hidden"
        aria-hidden="true"
      />
      <!-- Boat carrying the poop emoji. Bottom-left, sized to sit
           with hull straddling the wave-line — top half over the
           transparent area, hull in the water. -->
      <svg
        class="absolute bottom-2 left-2 size-20"
        viewBox="0 0 80 80"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="A boat carrying the poop emoji"
      >
        <path d="M38 16 Q40 12 42 16 L42 22 L38 22 Z" fill="#ca8a04" />
        <ellipse cx="40" cy="26" rx="6" ry="5" fill="#ca8a04" />
        <ellipse cx="40" cy="36" rx="11" ry="6" fill="#a16207" />
        <ellipse cx="40" cy="50" rx="18" ry="9" fill="#92400e" />
        <circle cx="34" cy="48" r="2.6" fill="white" />
        <circle cx="46" cy="48" r="2.6" fill="white" />
        <circle cx="34.5" cy="48.5" r="1.4" fill="#1f2937" />
        <circle cx="46.5" cy="48.5" r="1.4" fill="#1f2937" />
        <path d="M34 54 Q40 57 46 54" stroke="#1f2937" stroke-width="1.5" fill="none" stroke-linecap="round" />
        <path d="M8 60 L72 60 L62 72 L18 72 Z" fill="#1d4ed8" />
      </svg>
      <!-- Title + subtitle. Pinned to the bottom of the hero so the
           subtitle's baseline sits just inside the water's bottom
           edge — the block reads as a caption floating on the wave.
           Padded left to clear the boat. -->
      <div class="absolute inset-x-0 bottom-3 pl-24">
        <h1 class="text-4xl font-bold tracking-tight text-slate-900">
          ShipShow
          <span
            :class="stats.bitbucketAuthState === 'unauthorized' ? 'text-red-600' : ''"
            :title="
              stats.bitbucketAuthState === 'unauthorized'
                ? 'BitBucket auth failed — the API token may have expired or been revoked. The next successful sync clears this.'
                : undefined
            "
            >!!</span
          >
        </h1>
        <p class="mt-1 text-base font-bold text-slate-600">Part show,&nbsp;&nbsp;part shitshow</p>
      </div>
    </header>

    <!-- `perspective-[1200px]` sets the vanishing point depth for every
         card's 3D hover transform. Each card carries its own slightly
         different rotateX / rotateY pair via StatCard3D's `tilt` prop so
         the grid reads as six distinct surfaces under hover, not one
         repeated template. Tone follows CMY-RGB (Members keeps the
         original blue): row 1 = cyan / fuchsia / blue, row 2 = yellow /
         green / red. -->
    <section class="grid grid-cols-1 gap-4 [perspective:1200px] sm:grid-cols-2 lg:grid-cols-3">
      <!-- Repos / Projects don't link anywhere yet — dedicated browse pages
           are next on the roadmap. The "Browse all →" hint is rendered as
           a placeholder so all six cards keep the same vertical rhythm
           (otherwise the two hint-less cards collapse to a shorter height
           and break the grid baseline). Swap to a real `to` prop when the
           pages land. -->
      <StatCard3D
        label="Repositories"
        :value="repos"
        hint="Browse all →"
        :glyph-path="GLYPHS.folder"
        tone="cyan"
        :tilt="{ x: 5, y: -3 }"
        :to="{ name: 'repositories' }"
      />
      <StatCard3D
        label="Projects"
        :value="projects"
        hint="Browse all →"
        :glyph-path="GLYPHS.rectangleStack"
        tone="fuchsia"
        :tilt="{ x: 3, y: 5 }"
        :to="{ name: 'projects' }"
      />
      <StatCard3D
        label="Contributors"
        :value="contributors"
        hint="Browse all →"
        :glyph-path="GLYPHS.users"
        tone="blue"
        :tilt="{ x: 6, y: -4 }"
        :to="{ name: 'members' }"
      />
      <StatCard3D
        label="Commits last 7 days"
        :value="commitsLast7Days"
        hint="Recent activity →"
        :glyph-path="GLYPHS.bolt"
        tone="yellow"
        :tilt="{ x: -2, y: -3 }"
        :to="{ name: 'activity', query: { after: activitySinceSevenDays } }"
      />
      <StatCard3D
        label="Commits last 30 days"
        :value="commitsLast30Days"
        hint="Trailing month →"
        :glyph-path="GLYPHS.calendar"
        tone="green"
        :tilt="{ x: -3, y: 6 }"
        :to="{ name: 'activity', query: { after: activitySinceThirtyDays } }"
      />
      <StatCard3D
        label="Commits (all-time)"
        :value="totalCommits"
        hint="Full stream →"
        :glyph-path="GLYPHS.chartBar"
        tone="red"
        :tilt="{ x: 6, y: 4 }"
        :to="{ name: 'activity' }"
      />
    </section>

    <!-- Workspace-wide 365-day commit heatmap. Sits between the stat
         cards and the tabbed Contributors / Activity panel — the same
         year-grid component used on user / repo / project detail
         pages, fed by the unfiltered /api/activity-daily aggregate. -->
    <section class="mt-8">
      <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity — last 365 days</h2>
      <CommitHeatmap :data="dailyCommits" />
    </section>

    <section class="mt-8">
      <!-- Tab buttons + contextual controls. Switching the active tab swaps
           both the right-side controls (window vs. filter dropdowns) and the
           panel below. Both panels are height-capped to the same value so the
           surrounding layout stays stable across tab switches. -->
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div role="tablist" class="flex gap-1 text-sm" aria-label="Dashboard panels">
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'contributors'"
            class="rounded-md px-3 py-1 font-medium transition"
            :class="activeTab === 'contributors' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'"
            @click="activeTab = 'contributors'"
          >
            Top contributors
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'activity'"
            class="rounded-md px-3 py-1 font-medium transition"
            :class="activeTab === 'activity' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'"
            @click="activeTab = 'activity'"
          >
            Recent activity
          </button>
        </div>

        <div v-if="activeTab === 'contributors'" class="flex gap-2 text-xs">
          <button
            v-for="w in windows"
            :key="w"
            type="button"
            class="rounded px-2 py-1 transition"
            :class="
              stats.contributorsWindow === w
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            "
            @click="stats.setContributorsWindow(w)"
          >
            {{ windowLabel(w) }}
          </button>
        </div>

        <div v-else class="flex flex-wrap items-center gap-2 text-xs">
          <label for="dashboard-filter-project" class="flex items-center gap-1">
            <span class="text-slate-500">Project:</span>
            <select
              id="dashboard-filter-project"
              v-model="filterProject"
              name="dashboard-filter-project"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by project"
            >
              <option :value="undefined">All</option>
              <option v-for="p in projectsPanel" :key="p.projectKey" :value="p.projectKey">{{ p.projectKey }}</option>
            </select>
          </label>
          <label for="dashboard-filter-repo" class="flex items-center gap-1">
            <span class="text-slate-500">Repository:</span>
            <select
              id="dashboard-filter-repo"
              v-model="filterRepo"
              name="dashboard-filter-repo"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by repository"
            >
              <option :value="undefined">All</option>
              <option v-for="r in repoFilterOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
            </select>
          </label>
          <label for="dashboard-filter-user" class="flex items-center gap-1">
            <span class="text-slate-500">Contributor:</span>
            <ActorPicker id="dashboard-filter-user" v-model="filterActor" />
          </label>
          <button
            v-if="filtersActive"
            type="button"
            class="cursor-pointer text-slate-500 hover:text-slate-700"
            @click="clearFilters"
          >
            Clear
          </button>
        </div>
      </div>

      <!-- Contributors tab — internal scroll matches the activity panel so
           swapping tabs doesn't reflow the page. -->
      <div
        v-show="activeTab === 'contributors'"
        role="tabpanel"
        class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <div :style="{ height: ACTIVITY_PANEL_HEIGHT, overflowY: 'hidden' }">
          <ul v-if="stats.topContributors.length > 0" class="divide-y divide-slate-100">
            <li v-for="(c, i) in stats.topContributors" :key="`${c.entityKind}:${c.entityId}`">
              <!-- Whole row is one link target — `group` lives on the
                   RouterLink so descendant `group-hover:*` variants still
                   match on hover, and the row gets a soft slate-50 wash so
                   it reads as clickable everywhere, not just on the name.
                   Person rows link to /people/:id, user rows to /users/:id. -->
              <RouterLink
                :to="
                  c.entityKind === 'person'
                    ? { name: 'person', params: { personId: c.entityId } }
                    : { name: 'user', params: { userId: c.entityId } }
                "
                class="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <span class="w-5 shrink-0 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
                <span class="flex w-48 shrink-0 items-center gap-1.5 truncate text-sm font-medium text-slate-900">
                  <span class="truncate" :title="c.displayName">{{ c.displayName }}</span>
                  <span
                    v-if="c.entityKind === 'person' && c.attachedUserIds.length > 1"
                    class="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                    :title="`Merged from ${c.attachedUserIds.length} BitBucket accounts`"
                  >
                    ×{{ c.attachedUserIds.length }}
                  </span>
                </span>
                <!-- Vertical dividers flank the share bar — same height as
                   the bar, same `gap-3` spacing on both sides — so the bar
                   reads as a contained metric channel rather than free-
                   floating between the name and the sparkline. On row
                   hover both dividers shift to blue-600, matching the
                   sparkline's hover treatment. -->
                <span
                  class="h-6 w-px shrink-0 bg-slate-200 transition-colors group-hover:bg-blue-600"
                  aria-hidden="true"
                />
                <!-- Bar: log-normalised volume (adds + dels) over the
                   active 7d/30d window. The list is sorted by momentum;
                   this bar layers in window-scoped churn on a log scale
                   so the spread is readable across orders of magnitude.
                   Gradient `blue-200 → blue-700` covers the full track
                   (position-in-track determines the shade — left = light,
                   right = deep), and a `bg-slate-100` overlay masks the
                   unfilled right portion. Tooltip surfaces the raw
                   Momentum / Consistency values so the visual stays
                   honest about what the rank is built from. -->
                <div
                  class="relative h-6 min-w-0 flex-1 overflow-hidden rounded-sm bg-gradient-to-r from-blue-200 to-blue-700"
                  :title="`Momentum: ${tooltipMomentum(c.momentum)} · Consistency: ${tooltipConsistency(c.consistency90d)} · Volume: ${tooltipVolume(c)}`"
                  :aria-label="`Momentum ${tooltipMomentum(c.momentum)}, Consistency ${tooltipConsistency(c.consistency90d)}, Volume ${tooltipVolume(c)}`"
                >
                  <div
                    class="absolute right-0 top-0 h-full bg-slate-100"
                    :style="{ width: 100 - volumeShare(c) + '%' }"
                  />
                  <span class="share-bar-sheen pointer-events-none absolute inset-0" aria-hidden="true" />
                </div>
                <!-- `mr-4` on the right divider pushes the sparkline farther
                   from the bar — bar→sparkline gap = gap-3 + mr-4 = 28px. -->
                <span
                  class="mr-4 h-6 w-px shrink-0 bg-slate-200 transition-colors group-hover:bg-blue-600"
                  aria-hidden="true"
                />
                <Sparkline
                  :points="c.last30Days"
                  :width="128"
                  :height="16"
                  class="shrink-0 text-slate-400 transition-colors group-hover:text-blue-600"
                />
                <!-- Window-scoped adds / dels — same 3-column grid as
                     the Members table, with the `/` centered in a
                     fixed column so the separator lines up vertically
                     down the panel. Adds right-justify into the gap,
                     dels left-justify out of it. -->
                <div class="grid w-32 shrink-0 grid-cols-[1fr_auto_1fr] items-baseline gap-1 text-xs tabular-nums">
                  <span class="text-right text-emerald-600">+{{ c.additionsWindow.toLocaleString() }}</span>
                  <span class="text-slate-300">/</span>
                  <span class="text-left text-rose-600">−{{ c.deletionsWindow.toLocaleString() }}</span>
                </div>
                <!-- Digit gets the flex-1 left slot (right-aligned via
                     text-right); label sits in a fixed-width right
                     slot, left-aligned, plural-aware. Because the
                     label box is the same width on every row, the
                     digit's right edge and the label's left edge
                     are uniform across rows — `1 commit` / `1 repo`
                     stay grammatically correct without breaking the
                     column alignment. -->
                <div class="flex w-24 shrink-0 items-baseline gap-1 text-sm tabular-nums text-slate-500">
                  <span class="flex-1 text-right">{{ c.commits }}</span>
                  <span class="w-14 text-left">commit{{ c.commits !== 1 ? 's' : '' }}</span>
                </div>
                <div class="flex w-16 shrink-0 items-baseline gap-1 text-sm tabular-nums text-slate-500">
                  <span class="flex-1 text-right">{{ c.reposWindow }}</span>
                  <span class="w-10 text-left">repo{{ c.reposWindow !== 1 ? 's' : '' }}</span>
                </div>
              </RouterLink>
            </li>
          </ul>
          <p v-else class="px-4 py-6 text-center text-sm text-slate-400">
            No commits in the {{ windowLabel(stats.contributorsWindow).toLowerCase() }}.
          </p>
        </div>
        <!-- "More →" footer — sits below the height-capped scrolling area
             so it stays in view regardless of how many rows render above. -->
        <RouterLink
          :to="{ name: 'members' }"
          class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          More →
        </RouterLink>
      </div>

      <!-- Activity tab — same height cap so the surrounding layout doesn't
           shift when switching tabs. v-show keeps the component mounted, so
           any filter state / loaded pages stay live across tab toggles. -->
      <div v-show="activeTab === 'activity'" role="tabpanel">
        <ActivityFeed :actor="filterActor" :repo="filterRepo" :project="filterProject" :height="ACTIVITY_PANEL_HEIGHT">
          <template #footer>
            <!-- Mirror of the contributors footer. Lands on /activity
                 with the "last 7 days" range pre-applied so the user
                 picks up where the dashboard's quick-look left off. -->
            <RouterLink
              :to="{ name: 'activity', query: { after: activitySinceSevenDays } }"
              class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              More →
            </RouterLink>
          </template>
        </ActivityFeed>
      </div>
    </section>

    <!-- Top 10 repositories by recent commit volume. Always visible —
         a workspace-wide leaderboard belongs above the fold rather
         than behind a collapsible row. The dedicated Projects page
         carries the full searchable / paginated list. -->
    <section class="mt-8">
      <h2 class="mb-3 text-lg font-semibold text-slate-900">Top 10 repositories · last 30 days</h2>
      <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table v-if="topRepos.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th class="w-8 px-2 py-2 text-center font-medium"><span class="sr-only">Sync state</span></th>
              <th class="px-4 py-2 text-left font-medium">Repository</th>
              <th class="px-4 py-2 text-left font-medium">Project</th>
              <th class="px-4 py-2 text-right font-medium">Commits 30d</th>
              <th class="px-4 py-2 text-right font-medium">Contributors 30d</th>
              <th class="px-4 py-2 text-right font-medium">Last commit</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="r in topRepos" :key="r.fullName" class="hover:bg-slate-50">
              <td class="px-2 py-2 text-center align-middle">
                <SyncStateIcon :status="r.syncStatus" />
              </td>
              <td class="px-4 py-2">
                <RouterLink
                  :to="{ name: 'repository', params: { workspace: r.workspace, slug: r.slug } }"
                  class="font-medium text-slate-900 hover:text-slate-600"
                >
                  {{ r.slug }}
                </RouterLink>
              </td>
              <td class="px-4 py-2">
                <RouterLink
                  v-if="r.project"
                  :to="{ name: 'project', params: { projectKey: r.project } }"
                  class="text-slate-700 hover:text-slate-500"
                >
                  {{ r.project }}
                </RouterLink>
                <span v-else class="text-slate-400">—</span>
              </td>
              <td class="px-4 py-2 text-right text-slate-900">{{ r.commits30d }}</td>
              <td class="px-4 py-2 text-right text-slate-900">{{ r.contributors30d }}</td>
              <td class="px-4 py-2 text-right text-slate-500">{{ formatLastCommit(r.lastCommitAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No tracked repositories.</p>
        <!-- "More →" footer matches the contributors / activity tab
             footers — pinned to the bottom edge of the card, lands on
             the dedicated /repositories index. -->
        <RouterLink
          :to="{ name: 'repositories' }"
          class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
        >
          More →
        </RouterLink>
      </div>
    </section>

    <p v-if="stats.error" class="mt-4 text-sm text-red-600">Could not load stats: {{ stats.error }}</p>
  </main>
</template>

<style scoped>
/* Share-bar sheen: a soft white band that sweeps left→right across the
 * bar once each time its parent row enters hover. Resting state is
 * off-screen-left + invisible; the animation property is only attached
 * while the row is hovered, so removing hover removes the rule entirely
 * and re-hovering re-applies it (which restarts the animation). */
@keyframes share-bar-wave {
  from {
    transform: translateX(-100%);
  }

  to {
    transform: translateX(100%);
  }
}

.share-bar-sheen {
  background: linear-gradient(90deg, transparent 30%, rgba(255, 255, 255, 0.55) 50%, transparent 70%);
  transform: translateX(-100%);
}

.group:hover .share-bar-sheen {
  animation: share-bar-wave 0.9s ease-out 1 both;
}

/* Slow left→right shimmer over the hero water. Same idea as the
 * Repositories top-5 bar sweep — a soft translucent gradient
 * translating from one edge to the other on a long ease-in-out
 * loop. Lives in the .water-sheen overlay div pinned to the water
 * layer's bounds so the boat / text above stay untouched. */
@keyframes water-sheen-sweep {
  0% {
    transform: translateX(-100%);
  }

  55% {
    transform: translateX(110%);
  }

  100% {
    transform: translateX(110%);
  }
}

.water-sheen::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.55) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: water-sheen-sweep 6s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .water-sheen::after {
    animation: none;
    display: none;
  }
}
</style>
