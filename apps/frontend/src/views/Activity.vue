<script setup lang="ts">
// Dedicated /activity page — full activity stream with filters, hash /
// message search, date-range picker, three concentration charts above
// the rows, and explicit Prev/Next pagination (100/page). Mirrors the
// /members page structure so the two list pages feel like siblings.
//
// Filter state is URL-synced via `route.query`, same pattern as the
// Dashboard activity tab: deep-linking a filtered view works, and the
// browser back button does what the user expects after a Clear.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ActivityRow from '@/components/ActivityRow.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import CommitDetailModal from '@/components/CommitDetailModal.vue';
import { ACTIVITY_PAGE_SIZE, useActivityPageStore, type ActivityPageFilters } from '@/stores/activity-page';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import { liveBus } from '@/lib/live';
import { api, type ActivityCommit } from '@/api/client';

const route = useRoute();
const router = useRouter();
const stats = useStatsStore();
const store = useActivityPageStore();

// SSE / fallback subscriptions for the year-grid heatmap. The paged
// row store + dashboard stats wire their own subscriptions in their
// store bodies — those stay registered for the app lifetime. The
// heatmap's daily fetch is view-scoped, so its listeners need to come
// down with the component.
const liveCleanups: Array<() => void> = [];

onMounted(() => {
  // Snapshot the URL filters once on entry so the title chips can
  // disappear when the user later touches a dropdown. Re-mounts (back
  // button, fresh deep link) re-snapshot naturally.
  initialFilters.value = {
    actor: typeof route.query.actor === 'string' ? route.query.actor : undefined,
    repo: typeof route.query.repo === 'string' ? route.query.repo : undefined,
    project: typeof route.query.project === 'string' ? route.query.project : undefined,
  };
  void stats.fetchOverview();
  reload();
  void loadCharts();
  liveCleanups.push(liveBus.on('tick.commits.complete', () => void loadCharts()));
  liveCleanups.push(liveBus.on('repository.deleted', () => void loadCharts()));
  liveCleanups.push(liveBus.onFallback(() => void loadCharts()));
});

onUnmounted(() => {
  // Tear down the chart subscriptions so a navigated-away view isn't
  // still hitting the network on every tick.
  for (const off of liveCleanups) off();
  liveCleanups.length = 0;
  // Clear the volatile cache on unmount — re-entering the page should
  // refetch fresh data, not show whatever was last loaded with a stale
  // filter set.
  store.clear();
});

// ---------------------------------------------------------------------------
// URL <-> filter state. Every filter axis lives in `route.query` so deep
// links work and the Back button works as expected.
// ---------------------------------------------------------------------------

function setQueryParam(key: string, value: string | number | undefined): void {
  const next = { ...route.query };
  if (value === undefined || value === '') delete next[key];
  else next[key] = String(value);
  void router.replace({ query: next });
}

function clearQueryParams(keys: string[]): void {
  const next = { ...route.query };
  for (const k of keys) delete next[k];
  void router.replace({ query: next });
}

const filterActor = computed<number | undefined>({
  get: () => (route.query.actor !== undefined ? Number(route.query.actor) : undefined),
  set: (v) => setQueryParam('actor', v),
});
// Project + repo go through the shared composable so picking a repo
// auto-fills its project (and vice-versa, trimming the repo dropdown
// to the chosen project's repos). `repoFilterOptions` is the trimmed
// list for the `<select>` below.
const {
  projectModel: filterProject,
  repoModel: filterRepo,
  repoOptions: repoFilterOptions,
} = useActivityFilters({
  repositories: computed(() => stats.repositories),
});

// Date range — `<input type="date">` only accepts `YYYY-MM-DD`; anything
// else (including a perfectly valid ISO timestamp) emits a browser-level
// "does not conform to the required format" warning, which the project's
// zero-warning policy treats as a bug. Coerce on read so the input
// always sees a date-only string while the URL is free to carry either
// form — `isoFromDateInput` below accepts both at request time.
function toDateInputValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Default for the "To" bound when the URL doesn't carry one — local
// today, so visiting /activity lands with a sensible upper limit
// rather than an empty `mm/dd/yyyy` placeholder. Read fresh each time
// the getter fires so a long-lived session crosses midnight cleanly.
function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const filterAfterDate = computed<string | undefined>({
  get: () => toDateInputValue(route.query.after),
  set: (v) => setQueryParam('after', v),
});
const filterBeforeDate = computed<string | undefined>({
  get: () => toDateInputValue(route.query.before) ?? todayDateString(),
  set: (v) => setQueryParam('before', v),
});

// Period chip in the page title. Lights up when the URL's `?after=`
// exactly matches one of the Dashboard commit-card shortcuts (7d, 30d,
// or all-time = no `?after=`); the moment the user picks a custom
// range, the match fails and the chip silently disappears. Colors
// mirror the matching stat cards in Dashboard.vue:
//   yellow-500 = Commits last 7 days
//   green-500  = Commits last 30 days
//   red-500    = Commits all-time
const DAY_MS_LOCAL = 86_400_000;
function localDateStringFor(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
type RangePreset = '7d' | '30d' | 'all' | null;
const rangePreset = computed<RangePreset>(() => {
  const raw = route.query.after;
  const after = typeof raw === 'string' ? raw : undefined;
  if (after === undefined || after === '') return 'all';
  if (after === localDateStringFor(new Date(Date.now() - 7 * DAY_MS_LOCAL))) return '7d';
  if (after === localDateStringFor(new Date(Date.now() - 30 * DAY_MS_LOCAL))) return '30d';
  return null;
});

// Title chips for the structural filters (actor / repo / project).
// Snapshot the URL values at mount so the chips stick around for
// filters that arrived from a deep link or a "See all activities →"
// footer; the snapshot is burned (set to undefined) the moment the
// user diverges from it via the dropdown. Burning rather than
// equality-comparing means re-picking the original value later
// doesn't resurrect the chip — once a filter is user-controlled, it
// stays user-controlled for the rest of this mount. Time-range chip
// uses preset-matching (yellow / green / red labels aren't tied to
// any one user pick) and doesn't share this snapshot.
interface InitialFilters {
  actor: string | undefined;
  repo: string | undefined;
  project: string | undefined;
}
const initialFilters = ref<InitialFilters>({ actor: undefined, repo: undefined, project: undefined });

// Burn snapshots on first divergence. Watch covers all three axes in
// one pass — the URL goes through `router.replace` so changes flow
// through `route.query` deterministically and the watcher fires
// before the chip computeds re-evaluate.
watch(
  () => [route.query.actor, route.query.repo, route.query.project] as const,
  ([nextActor, nextRepo, nextProject]) => {
    const actor = typeof nextActor === 'string' ? nextActor : undefined;
    const repo = typeof nextRepo === 'string' ? nextRepo : undefined;
    const project = typeof nextProject === 'string' ? nextProject : undefined;
    if (initialFilters.value.actor !== undefined && actor !== initialFilters.value.actor) {
      initialFilters.value.actor = undefined;
    }
    if (initialFilters.value.repo !== undefined && repo !== initialFilters.value.repo) {
      initialFilters.value.repo = undefined;
    }
    if (initialFilters.value.project !== undefined && project !== initialFilters.value.project) {
      initialFilters.value.project = undefined;
    }
  },
);

// Each chip carries both the rendered label AND the route target for
// the detail page it represents, so the chip doubles as a quick-jump
// link back to the surface that pre-applied the filter.
interface Chip {
  label: string;
  to: { name: string; params: Record<string, string | number> };
}
function chipFor(
  current: string | undefined,
  initial: string | undefined,
  build: (v: string) => Chip | undefined,
): Chip | undefined {
  if (initial === undefined) return undefined;
  if (current !== initial) return undefined;
  return build(current);
}

const chipActor = computed<Chip | undefined>(() =>
  chipFor(typeof route.query.actor === 'string' ? route.query.actor : undefined, initialFilters.value.actor, (v) => {
    const id = Number(v);
    if (!Number.isFinite(id) || id <= 0) return undefined;
    const contrib = stats.topContributors.find((c) => c.userId === id);
    return {
      label: contrib?.displayName ?? `User #${v}`,
      to: { name: 'user', params: { userId: id } },
    };
  }),
);
const chipRepo = computed<Chip | undefined>(() =>
  chipFor(typeof route.query.repo === 'string' ? route.query.repo : undefined, initialFilters.value.repo, (v) => {
    const [workspace, slug] = v.split('/');
    if (workspace === undefined || slug === undefined || workspace === '' || slug === '') return undefined;
    const repo = stats.repositories.find((r) => r.fullName === v);
    return {
      label: repo?.slug ?? slug,
      to: { name: 'repository', params: { workspace, slug } },
    };
  }),
);
const chipProject = computed<Chip | undefined>(() =>
  chipFor(
    typeof route.query.project === 'string' ? route.query.project : undefined,
    initialFilters.value.project,
    (v) => ({ label: v, to: { name: 'project', params: { projectKey: v } } }),
  ),
);

// Search input is auto-detected: a hex-only string (1–40 chars) → hash
// mode, anything else → message mode. URL carries them in distinct keys
// so reloading preserves the mode without re-detecting.
const filterHash = computed<string | undefined>({
  get: () => (typeof route.query.hash === 'string' ? route.query.hash : undefined),
  set: (v) => setQueryParam('hash', v),
});
const filterMessage = computed<string | undefined>({
  get: () => (typeof route.query.message === 'string' ? route.query.message : undefined),
  set: (v) => setQueryParam('message', v),
});

// Single text input the user sees. Hydrated from whichever URL key is
// set (hash takes precedence if both are somehow set).
const searchText = ref<string>(filterHash.value ?? filterMessage.value ?? '');

const HEX_RE = /^[0-9a-f]+$/i;
const searchMode = computed<'hash' | 'message' | 'empty'>(() => {
  const q = searchText.value.trim();
  if (q === '') return 'empty';
  if (q.length <= 40 && HEX_RE.test(q)) return 'hash';
  return 'message';
});

// Server-side bound — must match the zod min on /api/activity's
// `message` query param. The backend rejects anything shorter with 400,
// so we hold the request locally until the user types past the bound
// (still mid-word from the user's perspective; the spinner gives the
// affordance that we're "typing along" with them).
const MESSAGE_MIN_LEN = 2;

// 300ms debounce — server-side FTS is fast but we still don't want to
// fire a request per keystroke. The "loading" spinner badge inside the
// input gives the user immediate feedback even before the debounce
// fires.
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchText, (next, prev) => {
  if (next === prev) return;
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const trimmed = next.trim();
    if (trimmed === '') {
      clearQueryParams(['hash', 'message']);
      return;
    }
    if (searchMode.value === 'hash') {
      // Hash regex (1–40 hex) is the same on both sides — anything that
      // got `searchMode === 'hash'` is also acceptable to the server.
      clearQueryParams(['message']);
      setQueryParam('hash', trimmed.toLowerCase());
    } else {
      // Message search needs at least MESSAGE_MIN_LEN chars on the
      // server side. Below that, drop any stale `message` from the URL
      // and don't fire — the user is still typing the first word.
      if (trimmed.length < MESSAGE_MIN_LEN) {
        clearQueryParams(['hash', 'message']);
        return;
      }
      clearQueryParams(['hash']);
      setQueryParam('message', trimmed);
    }
  }, 300);
});

// `filterBeforeDate` always reads as today when the URL is bare (so the
// `<input type="date">` lands populated), which means it can't drive
// the "any filter active?" check on its own — that has to gate on the
// URL key directly so the Clear button stays hidden in the default
// state and re-appears only after the user explicitly picks a bound.
const filtersActive = computed(
  () =>
    filterActor.value !== undefined ||
    filterRepo.value !== undefined ||
    filterProject.value !== undefined ||
    filterAfterDate.value !== undefined ||
    typeof route.query.before === 'string' ||
    filterHash.value !== undefined ||
    filterMessage.value !== undefined,
);

function clearFilters(): void {
  searchText.value = '';
  clearQueryParams(['actor', 'repo', 'project', 'after', 'before', 'hash', 'message']);
}

// ---------------------------------------------------------------------------
// Filter assembly + reload wiring
// ---------------------------------------------------------------------------

function isoFromDateInput(d: string, endOfDay: boolean): string | undefined {
  // The URL can carry either YYYY-MM-DD (typed into the date inputs, or
  // dropped in by the Dashboard's stat-card links) or a full ISO string
  // (deep links pasted from elsewhere). Detect ISO by the presence of
  // `T` and pass it through unchanged; otherwise interpret as a local-
  // time date boundary. End-of-day rolls forward to start-of-next-day
  // so the API's exclusive `before` cleanly excludes nothing within
  // the chosen day.
  if (d.includes('T')) {
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const parts = d.split('-').map(Number);
  if (parts.length !== 3) return undefined;
  const [y, m, day] = parts as [number, number, number];
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) return undefined;
  const dt = new Date(y, m - 1, endOfDay ? day + 1 : day);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

const currentFilters = computed<ActivityPageFilters>(() => {
  const f: ActivityPageFilters = {};
  if (filterActor.value !== undefined) f.actor = filterActor.value;
  if (filterRepo.value !== undefined) f.repo = filterRepo.value;
  if (filterProject.value !== undefined) f.project = filterProject.value;
  if (filterAfterDate.value !== undefined) {
    const iso = isoFromDateInput(filterAfterDate.value, false);
    if (iso !== undefined) f.after = iso;
  }
  if (filterBeforeDate.value !== undefined) {
    const iso = isoFromDateInput(filterBeforeDate.value, true);
    if (iso !== undefined) f.before = iso;
  }
  // Belt-and-suspenders bounds check — the backend's zod schema would
  // reject these with 400 anyway, but deep-linking a malformed URL
  // shouldn't surface a network error in the console.
  if (filterHash.value !== undefined && /^[0-9a-f]{1,40}$/i.test(filterHash.value)) {
    f.hashPrefix = filterHash.value;
  }
  if (filterMessage.value !== undefined && filterMessage.value.length >= MESSAGE_MIN_LEN) {
    f.message = filterMessage.value;
  }
  return f;
});

const filtersKey = computed(() => JSON.stringify(currentFilters.value));
watch(filtersKey, () => {
  reload();
});

function reload(): void {
  void store.load(currentFilters.value);
}

function firstPage(): void {
  void store.first(currentFilters.value);
}

function prevPage(): void {
  void store.prev(currentFilters.value);
}

function nextPage(): void {
  void store.next(currentFilters.value);
}

function lastPage(): void {
  void store.last(currentFilters.value);
}

// ---------------------------------------------------------------------------
// Heatmap data source — last 365 days, scoped only by project / repo /
// user. The row list's date / hash / message filters intentionally do
// NOT narrow it: the heatmap is contextual ("what does the year look
// like for this slice?"), not a "what's on this page" mirror.
// ---------------------------------------------------------------------------

const dailyData = ref<{ date: string; commits: number }[]>([]);

const chartFiltersKey = computed(() =>
  JSON.stringify({
    actor: filterActor.value ?? null,
    repo: filterRepo.value ?? null,
    project: filterProject.value ?? null,
  }),
);

async function loadCharts(): Promise<void> {
  const q: { actor?: number; repo?: string; project?: string } = {};
  if (filterActor.value !== undefined) q.actor = filterActor.value;
  if (filterRepo.value !== undefined) q.repo = filterRepo.value;
  if (filterProject.value !== undefined) q.project = filterProject.value;
  try {
    dailyData.value = await api.activityDaily(q);
  } catch {
    // Heatmap is supplementary — fall back to empty rather than blocking
    // the page. The row list surfaces its own errors via `store.error`.
    dailyData.value = [];
  }
}

watch(chartFiltersKey, () => {
  void loadCharts();
});

// ---------------------------------------------------------------------------
// Repository options for the repo dropdown — sorted by recent activity so
// the most-relevant choices float to the top. Project + user dropdowns
// pull from the same source as the Dashboard.
// ---------------------------------------------------------------------------

const projectOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const r of stats.repositories) if (r.project !== null) set.add(r.project);
  return Array.from(set).sort();
});

// ---------------------------------------------------------------------------
// Commit detail modal — shared with ActivityFeed semantics. Prev/Next
// walk through commits within the currently loaded page.
// ---------------------------------------------------------------------------

const commitEntries = computed<ActivityCommit[]>(() =>
  store.entries.filter((e): e is ActivityCommit => e.kind === 'commit'),
);
const selectedSha = ref<string | null>(null);
const selectedCommit = computed<ActivityCommit | null>(() => {
  if (selectedSha.value === null) return null;
  return commitEntries.value.find((c) => c.sha === selectedSha.value) ?? null;
});
const selectedIndex = computed<number>(() =>
  selectedSha.value === null ? -1 : commitEntries.value.findIndex((c) => c.sha === selectedSha.value),
);
const canPrev = computed(() => selectedIndex.value > 0);
const canNext = computed(() => selectedIndex.value >= 0 && selectedIndex.value < commitEntries.value.length - 1);

function openCommit(sha: string): void {
  selectedSha.value = sha;
}
function closeModal(): void {
  selectedSha.value = null;
}
function prevCommit(): void {
  if (!canPrev.value) return;
  const next = commitEntries.value[selectedIndex.value - 1];
  if (next !== undefined) selectedSha.value = next.sha;
}
function nextCommit(): void {
  if (!canNext.value) return;
  const next = commitEntries.value[selectedIndex.value + 1];
  if (next !== undefined) selectedSha.value = next.sha;
}
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 flex flex-wrap items-baseline gap-x-2 text-3xl font-bold tracking-tight text-slate-900">
        <span>Activity</span>
        <!-- Time-range chip (preset-matched against the URL). Resets
             automatically when the user picks a custom date. -->
        <span
          v-if="rangePreset === '7d'"
          class="text-base font-medium text-yellow-600"
          aria-label="Filtered to the last 7 days"
        >
          [Last 7 days]
        </span>
        <span
          v-else-if="rangePreset === '30d'"
          class="text-base font-medium text-green-600"
          aria-label="Filtered to the last 30 days"
        >
          [Last 30 days]
        </span>
        <span
          v-else-if="rangePreset === 'all'"
          class="text-base font-medium text-red-600"
          aria-label="Showing all time"
        >
          [All time]
        </span>
        <!-- Structural-filter chips. Each one's gate is initial-vs-
             current; touching the dropdown drifts the current value
             away from the snapshot and the chip hides. Colours mirror
             the matching Dashboard stat-card tones (blue / cyan /
             fuchsia) for a quick visual link back to the landing
             surface. -->
        <RouterLink
          v-if="chipActor !== undefined"
          :to="chipActor.to"
          class="text-base font-medium text-blue-600 hover:underline"
          :aria-label="`Open user detail for ${chipActor.label}`"
        >
          [{{ chipActor.label }}]
        </RouterLink>
        <RouterLink
          v-if="chipRepo !== undefined"
          :to="chipRepo.to"
          class="text-base font-medium text-cyan-600 hover:underline"
          :aria-label="`Open repository detail for ${chipRepo.label}`"
        >
          [{{ chipRepo.label }}]
        </RouterLink>
        <RouterLink
          v-if="chipProject !== undefined"
          :to="chipProject.to"
          class="text-base font-medium text-fuchsia-600 hover:underline"
          :aria-label="`Open project detail for ${chipProject.label}`"
        >
          [{{ chipProject.label }}]
        </RouterLink>
      </h1>
      <p class="mt-1 text-sm text-slate-500">Every commit and pull request across the workspace, freshest first.</p>
    </header>

    <!-- Year-grid heatmap above the filter row. Reflects the last 365
         days scoped only by project / repo / user — date range / hash /
         message filters on the row list don't narrow it, which keeps
         the chart readable as the user searches. -->
    <section class="mb-6">
      <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Activity — last 365 days</h2>
      <CommitHeatmap :data="dailyData" />
    </section>

    <!-- Filter row. Search input on the left, dropdowns + date range on
         the right. Hidden helper text under the input tells the user
         what mode (hash / message) we auto-detected. -->
    <section class="mb-3 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="relative">
          <!-- Magnifying-glass affordance anchored inside the input on
               the left. The loading spinner takes the matching slot on
               the right when `store.loading` is true. -->
          <svg
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
            />
          </svg>
          <input
            id="activity-search"
            v-model="searchText"
            type="search"
            name="activity-search"
            autocomplete="off"
            placeholder="Search by commit hash or message…"
            class="w-96 rounded-md border border-slate-200 bg-white py-2 pl-9 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
            :aria-label="searchMode === 'hash' ? 'Search by commit hash' : 'Search commit messages and PR titles'"
          />
          <!-- Loading spinner badge — replaces the right padding when a
               search-driven request is in flight. Stays visible while
               `store.loading` is true regardless of what triggered the
               fetch (page change, dropdown filter, search). -->
          <span
            v-if="store.loading"
            class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          >
            <svg
              class="size-4 animate-spin text-slate-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </span>
        </div>
        <!-- Top pagination — mirrors the bottom footer's button set so
             the user has identical controls whether they're skimming
             the head of the list or just landed on the page. Wraps to
             a new row when the viewport gets narrow. -->
        <div class="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span>
            Page {{ store.page }} of {{ store.pageCount }} ·
            <span class="tabular-nums">{{ store.total }}</span> entr<span v-if="store.total === 1">y</span
            ><span v-else>ies</span>
          </span>
          <div class="flex gap-1">
            <button
              type="button"
              class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              :disabled="!store.canFirst || store.loading"
              @click="firstPage"
            >
              First
            </button>
            <button
              type="button"
              class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              :disabled="!store.canPrev || store.loading"
              @click="prevPage"
            >
              Prev
            </button>
            <button
              type="button"
              class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              :disabled="!store.canNext || store.loading"
              @click="nextPage"
            >
              Next
            </button>
            <button
              type="button"
              class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              :disabled="!store.canLast || store.loading"
              @click="lastPage"
            >
              Last
            </button>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3 text-xs">
        <span
          v-if="searchMode !== 'empty'"
          class="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600"
          :title="
            searchMode === 'hash'
              ? 'Looks like a commit hash prefix — searching by hash, PRs hidden'
              : 'Searching commit messages and PR titles'
          "
        >
          {{ searchMode === 'hash' ? 'Hash match' : 'Message search' }}
        </span>
        <label for="activity-filter-project" class="flex items-center gap-1">
          <span class="text-slate-500">Project:</span>
          <select
            id="activity-filter-project"
            v-model="filterProject"
            name="activity-filter-project"
            class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
            aria-label="Filter by project"
          >
            <option :value="undefined">All</option>
            <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>
        <label for="activity-filter-repo" class="flex items-center gap-1">
          <span class="text-slate-500">Repository:</span>
          <select
            id="activity-filter-repo"
            v-model="filterRepo"
            name="activity-filter-repo"
            class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
            aria-label="Filter by repository"
          >
            <option :value="undefined">All</option>
            <option v-for="r in repoFilterOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
          </select>
        </label>
        <label for="activity-filter-user" class="flex items-center gap-1">
          <span class="text-slate-500">User:</span>
          <select
            id="activity-filter-user"
            v-model.number="filterActor"
            name="activity-filter-user"
            class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
            aria-label="Filter by user"
          >
            <option :value="undefined">All</option>
            <option v-for="c in stats.topContributors" :key="c.userId" :value="c.userId">{{ c.displayName }}</option>
          </select>
        </label>
        <label for="activity-filter-from" class="flex items-center gap-1">
          <span class="text-slate-500">From:</span>
          <input
            id="activity-filter-from"
            v-model="filterAfterDate"
            type="date"
            name="activity-filter-from"
            class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
            aria-label="Range start date"
          />
        </label>
        <label for="activity-filter-to" class="flex items-center gap-1">
          <span class="text-slate-500">To:</span>
          <input
            id="activity-filter-to"
            v-model="filterBeforeDate"
            type="date"
            name="activity-filter-to"
            class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
            aria-label="Range end date"
          />
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
    </section>

    <section class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <p v-if="store.error" class="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
        Could not load activity: {{ store.error }}
      </p>

      <ul v-if="store.entries.length > 0" class="divide-y divide-slate-100">
        <ActivityRow
          v-for="entry in store.entries"
          :key="
            entry.kind === 'commit'
              ? `c-${entry.sha}`
              : `p-${entry.repository.fullName}-${entry.prId}-${entry.occurredAt}`
          "
          :entry="entry"
          @open-commit="openCommit"
        />
      </ul>

      <p v-else-if="store.loading" class="px-4 py-6 text-center text-sm text-slate-400">Loading…</p>
      <p v-else-if="filtersActive" class="px-4 py-6 text-center text-sm text-slate-400">
        No activity matches your filters.
      </p>
      <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No activity yet.</p>

      <div
        v-if="store.total > 0"
        class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500"
      >
        <span> Page {{ store.page }} of {{ store.pageCount }} · {{ ACTIVITY_PAGE_SIZE }} per page </span>
        <div class="flex gap-1">
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="!store.canFirst || store.loading"
            @click="firstPage"
          >
            First
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="!store.canPrev || store.loading"
            @click="prevPage"
          >
            Prev
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="!store.canNext || store.loading"
            @click="nextPage"
          >
            Next
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="!store.canLast || store.loading"
            @click="lastPage"
          >
            Last
          </button>
        </div>
      </div>
    </section>

    <CommitDetailModal
      v-if="selectedCommit !== null"
      :commit="selectedCommit"
      :can-prev="canPrev"
      :can-next="canNext"
      @close="closeModal"
      @prev="prevCommit"
      @next="nextCommit"
    />
  </main>
</template>
