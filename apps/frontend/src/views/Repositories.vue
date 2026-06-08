<script setup lang="ts">
// /repositories index page.
//
// Operator-leaning sibling to /projects: every tracked repo with
// sortable columns, project + sync-status filters, and a sync-health
// donut up top so a glance answers "is the pipeline healthy?". The
// row count is workspace-bounded (~30–50 repos in practice), so 25
// per page handles the bulk in one visit while leaving paginator
// affordances for outliers.
//
// Sections, top to bottom:
//   1. Header (← Dashboard, title, subtitle)
//   2. Sync-health donut (full-width card)
//   3. Search + project filter + status pill toggle + count
//   4. Sortable repo table (25/page, full-row click)
//   5. Activity feed with "See all activities →" footer

import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ActivityFeed from '@/components/ActivityFeed.vue';
import ActorPicker from '@/components/ActorPicker.vue';
import ActivityStatusDonut, { type ActivityBucket } from '@/components/ActivityStatusDonut.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import { useActorFilter } from '@/composables/useActorFilter';
import type { RepoSyncStatus, TrackedRepositorySummary } from '@/api/client';

const stats = useStatsStore();
const route = useRoute();
const router = useRouter();

// Workspace for the "View on BitBucket" header link. Derived from
// the first tracked repo — the app is single-workspace by design,
// so any row's workspace is canonical. Empty until stats land,
// which hides the link via v-if rather than rendering a broken URL.
const workspace = computed(() => stats.repositories[0]?.workspace ?? '');

// Re-fetch on mount so a deep link into /repositories doesn't depend
// on a prior dashboard visit. The stats store already wires its own
// SSE subscriptions for the table + chart data — both surfaces read
// from `stats.repositories`, so nothing extra is needed at the view.
onMounted(() => {
  void stats.fetchOverview();
});

// ---------------------------------------------------------------------------
// URL <-> filter state. Search + project + status all live in
// `route.query` so deep links and the Back button work.
// ---------------------------------------------------------------------------

function setQueryParam(key: string, value: string | undefined): void {
  const next = { ...route.query };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  void router.replace({ query: next });
}

const search = computed<string>({
  get: () => (typeof route.query.q === 'string' ? route.query.q : ''),
  set: (v) => setQueryParam('q', v === '' ? undefined : v),
});
const projectFilter = computed<string | undefined>({
  get: () => (typeof route.query.project === 'string' ? route.query.project : undefined),
  set: (v) => setQueryParam('project', v),
});
type StatusFilter = 'all' | 'active' | 'issues' | 'archived';
const statusFilter = computed<StatusFilter>({
  get: () => {
    const v = route.query.status;
    if (v === 'active' || v === 'issues' || v === 'archived') return v;
    return 'all';
  },
  set: (v) => setQueryParam('status', v === 'all' ? undefined : v),
});

// 30-day cutoff for the "See all activities →" footer — matches the
// detail-page footers so /activity lands with the [Last 30 days] chip.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));

// Activity-feed filters (project / repo / contributor), mirroring the
// Projects page. These are SEPARATE controls from the repositories
// table filter above, so they use prefixed query keys (`aproject` /
// `arepo`) to avoid colliding with the table's own `?project`. The
// contributor axis is the shared person-aware ActorPicker on `?actor`.
const filterActor = useActorFilter();
const {
  projectModel: activityProject,
  repoModel: activityRepo,
  repoOptions: activityRepoOptions,
} = useActivityFilters({
  repositories: computed(() => stats.repositories),
  queryKeys: { project: 'aproject', repo: 'arepo' },
});
const activityFiltersActive = computed(
  () => filterActor.value !== undefined || activityProject.value !== undefined || activityRepo.value !== undefined,
);
function clearActivityFilters(): void {
  const next = { ...route.query };
  delete next.aproject;
  delete next.arepo;
  delete next.actor;
  delete next.actorKind;
  void router.replace({ query: next });
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

const projectOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const r of stats.repositories) if (r.project !== null) set.add(r.project);
  return Array.from(set).sort();
});

// Sync-health donut. Buckets are mutually exclusive so the slices sum
// to total repo count. Colours mirror the SyncStateIcon palette so
// the chart and the per-row icons share a visual language.
const SYNC_COLORS: Record<RepoSyncStatus, string> = {
  ok: '#10b981', // emerald-500
  error: '#f59e0b', // amber-500
  excluded: '#f43f5e', // rose-500
  never: '#94a3b8', // slate-400
  empty: '#cbd5e1', // slate-300 — benign (empty on BitBucket)
};

const syncBuckets = computed<ActivityBucket[]>(() => {
  const counts: Record<RepoSyncStatus, number> = { ok: 0, error: 0, excluded: 0, never: 0, empty: 0 };
  for (const r of stats.repositories) counts[r.syncStatus] += 1;
  return [
    { label: 'Active', count: counts.ok, color: SYNC_COLORS.ok },
    { label: 'Errored', count: counts.error, color: SYNC_COLORS.error },
    { label: 'Excluded', count: counts.excluded, color: SYNC_COLORS.excluded },
    { label: 'Pending', count: counts.never, color: SYNC_COLORS.never },
    { label: 'Empty', count: counts.empty, color: SYNC_COLORS.empty },
  ];
});

// Compound bar chart input — top 5 repos by 30-day commit volume.
// Bar length is scaled by commits; the bar's internal green/red split
// encodes the adds:dels ratio for that repo. Two scales co-existing
// in one bar gives the row a single visual unit conveying both
// "throughput" and "change shape". Capped at 5 because the chart now
// shares the panel row with the donut + legend — fewer rows lets the
// remaining bars stay tall enough to read.
interface BarRow {
  workspace: string;
  slug: string;
  fullName: string;
  project: string | null;
  commits30d: number;
  additions30d: number;
  deletions30d: number;
  // Length of the bar relative to the busiest repo in the top 10
  // (percent). Lets the user see, at a glance, who's outsized.
  widthPct: number;
  // Internal split. Falls back to 50/50 on repos with no diff stats
  // yet so the bar still renders something distinct from a gap.
  addPct: number;
  delPct: number;
}
const topReposByCommits = computed<BarRow[]>(() => {
  const top = stats.repositories
    .slice()
    .sort((a, b) => b.commits30d - a.commits30d)
    .slice(0, 5);
  const maxCommits = top[0]?.commits30d ?? 0;
  return top.map((r) => {
    const churn = r.additions30d + r.deletions30d;
    return {
      workspace: r.workspace,
      slug: r.slug,
      fullName: r.fullName,
      project: r.project,
      commits30d: r.commits30d,
      additions30d: r.additions30d,
      deletions30d: r.deletions30d,
      widthPct: maxCommits > 0 ? (r.commits30d / maxCommits) * 100 : 0,
      addPct: churn > 0 ? (r.additions30d / churn) * 100 : 50,
      delPct: churn > 0 ? (r.deletions30d / churn) * 100 : 50,
    };
  });
});

// ---------------------------------------------------------------------------
// Sort + filter + paginate (all client-side; the list is small)
// ---------------------------------------------------------------------------

type SortKey = 'slug' | 'project' | 'commits30d' | 'contributors30d' | 'lastCommitAt' | 'syncStatus';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('commits30d');
const sortDir = ref<SortDir>('desc');

function toggleSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = key === 'slug' || key === 'project' ? 'asc' : 'desc';
  }
  page.value = 1;
}

const filtered = computed<TrackedRepositorySummary[]>(() => {
  const q = search.value.trim().toLowerCase();
  const projectScope = projectFilter.value;
  const statusScope = statusFilter.value;
  return stats.repositories.filter((r) => {
    if (projectScope !== undefined && r.project !== projectScope) return false;
    if (statusScope === 'active' && (r.syncStatus !== 'ok' || r.archived)) return false;
    if (statusScope === 'issues' && r.syncStatus !== 'error' && r.syncStatus !== 'excluded') return false;
    if (statusScope === 'archived' && !r.archived) return false;
    if (q !== '') {
      const haystack = `${r.slug} ${r.project ?? ''} ${r.workspace}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
});

const sorted = computed<TrackedRepositorySummary[]>(() => {
  const list = filtered.value.slice();
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const key = sortKey.value;
  list.sort((a, b) => {
    if (key === 'slug') return a.slug.localeCompare(b.slug) * dir;
    if (key === 'project') return (a.project ?? '').localeCompare(b.project ?? '') * dir;
    if (key === 'syncStatus') return a.syncStatus.localeCompare(b.syncStatus) * dir;
    if (key === 'lastCommitAt') {
      const av = a.lastCommitAt;
      const bv = b.lastCommitAt;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    }
    return (a[key] - b[key]) * dir;
  });
  return list;
});

const PAGE_SIZE = 25;
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)));
const pageClamped = computed(() => Math.min(page.value, pageCount.value));
const paged = computed<TrackedRepositorySummary[]>(() => {
  const start = (pageClamped.value - 1) * PAGE_SIZE;
  return sorted.value.slice(start, start + PAGE_SIZE);
});

// Reset to page 1 whenever any filter changes — a search match of
// three rows shouldn't strand the user on page 3 of nothing.
watch([search, projectFilter, statusFilter], () => {
  page.value = 1;
});

const sortIndicator = (key: SortKey): string => {
  if (sortKey.value !== key) return '';
  return sortDir.value === 'asc' ? ' ▲' : ' ▼';
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function openRepo(r: TrackedRepositorySummary): void {
  void router.push({ name: 'repository', params: { workspace: r.workspace, slug: r.slug } });
}

// ---------------------------------------------------------------------------
// Project filter clear hook — useful when status pills + project filter
// combine to an empty result and the user wants out fast.
// ---------------------------------------------------------------------------

const filtersActive = computed(
  () => search.value.trim() !== '' || projectFilter.value !== undefined || statusFilter.value !== 'all',
);
function clearFilters(): void {
  const next = { ...route.query };
  delete next.q;
  delete next.project;
  delete next.status;
  void router.replace({ query: next });
}
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">Repositories</h1>
        <!-- Thin external link to BB's workspace-wide repository list.
             Hidden until stats land so the URL is never built from an
             empty workspace string. -->
        <a
          v-if="workspace"
          :href="`https://bitbucket.org/${workspace}/workspace/repositories`"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 text-xs text-slate-500 hover:text-blue-600"
          title="View on BitBucket"
        >
          View on BitBucket ↗
        </a>
      </div>
      <p class="mt-1 text-sm text-slate-500">
        Every tracked repository in the workspace, with sync health and recent activity.
      </p>
    </header>

    <!-- Twin-chart panel: sync health on the left answers "anything
         red that needs attention?"; the sunburst on the right answers
         "where do commits land and who's driving them?". One shared
         bordered card; a vertical divider (lg:divide-x) splits the
         two halves on wide viewports, falling back to a horizontal
         divider on narrow ones via divide-y. -->
    <section class="mb-6">
      <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <!-- 50/50 split on wide viewports — donut + its compact
             legend land in the left half, bar chart on the right.
             The donut takes meaningful horizontal real estate so the
             bar list gets the matching half rather than the wider
             allocation it had as a sibling-only component. Stacks on
             narrow viewports via grid-cols-1 with a horizontal
             divider via divide-y. -->
        <div class="grid grid-cols-1 divide-y divide-slate-100 lg:grid-cols-[3fr_2fr] lg:divide-x lg:divide-y-0">
          <div class="flex flex-col p-6">
            <h2 class="mb-4 text-xs font-medium uppercase tracking-wider text-slate-500">
              Top 5 repos by commits · last 30 days
            </h2>
            <!-- Compound bar chart. Each row is one repo. The bar's
                 length is the repo's commit count scaled against the
                 busiest in the top-10 (so the leader is 100% wide).
                 Inside the bar, a green segment for additions and a
                 red segment for deletions are sized by their share of
                 the repo's 30-day non-merge churn — the row encodes
                 both throughput AND change shape at a glance. -->
            <ul v-if="topReposByCommits.length > 0" class="space-y-2">
              <li v-for="(r, i) in topReposByCommits" :key="r.fullName" class="text-xs">
                <div class="mb-1 flex items-baseline justify-between gap-2">
                  <RouterLink
                    :to="{ name: 'repository', params: { workspace: r.workspace, slug: r.slug } }"
                    class="truncate font-medium text-slate-800 hover:text-slate-600"
                    :title="r.fullName"
                  >
                    {{ r.slug }}
                    <span v-if="r.project" class="ml-1 text-[10px] font-normal text-slate-400">{{ r.project }}</span>
                  </RouterLink>
                  <span class="shrink-0 tabular-nums text-slate-500">
                    {{ r.commits30d }} <span class="text-slate-400">commits</span>
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <div
                    class="h-3 min-w-[1px] flex-1 overflow-hidden rounded bg-slate-100"
                    :title="`${r.commits30d} commits · +${r.additions30d.toLocaleString()} −${r.deletions30d.toLocaleString()}`"
                  >
                    <div class="wave-fill flex h-full" :style="{ width: `${r.widthPct}%`, '--wave-i': i }">
                      <div class="bg-emerald-500" :style="{ width: `${r.addPct}%` }" />
                      <div class="bg-rose-500" :style="{ width: `${r.delPct}%` }" />
                    </div>
                  </div>
                  <span class="flex w-28 shrink-0 gap-2 tabular-nums">
                    <span class="flex-1 text-right text-emerald-700">+{{ r.additions30d.toLocaleString() }}</span>
                    <span class="flex-1 text-right text-rose-700">−{{ r.deletions30d.toLocaleString() }}</span>
                  </span>
                </div>
              </li>
            </ul>
            <p v-else class="py-6 text-center text-sm text-slate-400">No commits in the last 30 days.</p>
          </div>
          <div class="flex flex-col px-6 pb-6 pt-3">
            <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500">Sync health</h2>
            <!-- Inside the right cell: legend reads first on the
                 left, donut anchors the outer right edge. Percent
                 column dropped — the donut centre's "Repos / N"
                 already carries that summary. -->
            <ActivityStatusDonut
              :buckets="syncBuckets"
              center-label="Repos"
              :outer-radius="120"
              :inner-radius="78"
              legend-position="left"
              :show-percent="false"
              :tilt3d="true"
            />
          </div>
        </div>
      </div>
    </section>

    <!-- Filter row: search · project · status pills · count. Same
         layout idiom as the other index pages so the page feels
         familiar after Members / Projects / Activity. -->
    <section class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <div class="relative">
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
            id="repositories-search"
            v-model="search"
            type="search"
            name="repositories-search"
            autocomplete="off"
            placeholder="Search repositories…"
            class="w-72 rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
            aria-label="Search repositories"
          />
        </div>
        <label for="repositories-filter-project" class="flex items-center gap-1 text-xs">
          <span class="text-slate-500">Project:</span>
          <select
            id="repositories-filter-project"
            v-model="projectFilter"
            name="repositories-filter-project"
            class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
            aria-label="Filter by project"
          >
            <option :value="undefined">All</option>
            <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
          </select>
        </label>
        <div
          class="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-200 text-xs"
          role="group"
          aria-label="Sync status filter"
        >
          <button
            type="button"
            class="cursor-pointer px-3 py-2 transition"
            :class="statusFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'"
            @click="statusFilter = 'all'"
          >
            All
          </button>
          <button
            type="button"
            class="cursor-pointer px-3 py-2 transition"
            :class="
              statusFilter === 'active' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            "
            @click="statusFilter = 'active'"
          >
            Active
          </button>
          <button
            type="button"
            class="cursor-pointer px-3 py-2 transition"
            :class="
              statusFilter === 'issues' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            "
            @click="statusFilter = 'issues'"
          >
            Issues
          </button>
          <button
            type="button"
            class="cursor-pointer px-3 py-2 transition"
            :class="
              statusFilter === 'archived' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            "
            @click="statusFilter = 'archived'"
          >
            Archived
          </button>
        </div>
        <button
          v-if="filtersActive"
          type="button"
          class="cursor-pointer text-xs text-slate-500 hover:text-slate-700"
          @click="clearFilters"
        >
          Clear
        </button>
      </div>
      <span class="text-xs text-slate-500">
        {{ sorted.length }}
        <span v-if="filtersActive">match<span v-if="sorted.length !== 1">es</span></span>
        <span v-else>repositor<span v-if="sorted.length === 1">y</span><span v-else>ies</span></span>
      </span>
    </section>

    <!-- Repo table. Full row is clickable (cursor-pointer + @click on
         the <tr>); the slug cell keeps its <RouterLink> for native
         middle-click / Cmd-click open-in-new-tab support. -->
    <section class="mb-8 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table v-if="paged.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
        <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th class="w-8 px-2 py-2 text-center font-medium">
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('syncStatus')">
                <span class="sr-only">Sync state</span>
                <span aria-hidden="true">●{{ sortIndicator('syncStatus') }}</span>
              </button>
            </th>
            <th class="px-4 py-2 text-left font-medium">
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('slug')">
                Repository{{ sortIndicator('slug') }}
              </button>
            </th>
            <th class="px-4 py-2 text-left font-medium">
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('project')">
                Project{{ sortIndicator('project') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('commits30d')">
                Commits 30d{{ sortIndicator('commits30d') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('contributors30d')">
                Contributors 30d{{ sortIndicator('contributors30d') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('lastCommitAt')">
                Last commit{{ sortIndicator('lastCommitAt') }}
              </button>
            </th>
            <th class="w-10 px-2 py-2 text-center font-medium">
              <span class="sr-only">Open on BitBucket</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="r in paged" :key="r.fullName" class="cursor-pointer hover:bg-slate-50" @click="openRepo(r)">
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
              <span
                v-if="r.archived"
                class="ml-1.5 inline-block rounded bg-slate-200 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-slate-500"
                title="Soft-retired — excluded from sync; status shown is its last known state."
                >Archived</span
              >
              <div class="text-[10px] text-slate-400">{{ r.workspace }}</div>
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
            <td class="px-4 py-2 text-right text-[10px] text-slate-500">
              <template v-if="r.lastCommitAt !== null">
                <div>{{ formatDate(r.lastCommitAt) }}</div>
                <div class="text-slate-400">{{ formatTime(r.lastCommitAt) }}</div>
              </template>
              <span v-else>—</span>
            </td>
            <td class="px-2 py-2 text-center align-middle">
              <!-- External BB link. `@click.stop` keeps the row-click
                   handler from also firing (which would navigate to
                   the in-app detail page on top of opening BB).
                   `rel=noopener` is standard for target=_blank. -->
              <a
                :href="`https://bitbucket.org/${r.workspace}/${r.slug}`"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex text-slate-400 transition-colors hover:text-blue-600"
                title="View on BitBucket"
                aria-label="View on BitBucket"
                @click.stop
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-4"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="filtersActive" class="px-4 py-6 text-center text-sm text-slate-400">
        No repositories match the active filters.
      </p>
      <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No tracked repositories yet.</p>

      <div
        v-if="sorted.length > PAGE_SIZE"
        class="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500"
      >
        <span>
          Showing {{ (pageClamped - 1) * PAGE_SIZE + 1 }}–{{ Math.min(pageClamped * PAGE_SIZE, sorted.length) }} of
          {{ sorted.length }}
        </span>
        <div class="flex gap-1">
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="pageClamped <= 1"
            @click="page = 1"
          >
            First
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="pageClamped <= 1"
            @click="page = pageClamped - 1"
          >
            Prev
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="pageClamped >= pageCount"
            @click="page = pageClamped + 1"
          >
            Next
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            :disabled="pageClamped >= pageCount"
            @click="page = pageCount"
          >
            Last
          </button>
        </div>
      </div>
    </section>

    <!-- Activity feed with project / repo / contributor filters,
         mirroring the Projects page. These are independent of the
         repositories table filter above (prefixed query keys), so
         narrowing the feed doesn't disturb the table. -->
    <section class="mb-4">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <label for="repos-activity-filter-project" class="flex items-center gap-1">
            <span class="text-slate-500">Project:</span>
            <select
              id="repos-activity-filter-project"
              v-model="activityProject"
              name="repos-activity-filter-project"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter activity by project"
            >
              <option :value="undefined">All</option>
              <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label for="repos-activity-filter-repo" class="flex items-center gap-1">
            <span class="text-slate-500">Repository:</span>
            <select
              id="repos-activity-filter-repo"
              v-model="activityRepo"
              name="repos-activity-filter-repo"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter activity by repository"
            >
              <option :value="undefined">All</option>
              <option v-for="r in activityRepoOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
            </select>
          </label>
          <label for="repos-activity-filter-user" class="flex items-center gap-1">
            <span class="text-slate-500">Contributor:</span>
            <ActorPicker id="repos-activity-filter-user" v-model="filterActor" />
          </label>
          <button
            v-if="activityFiltersActive"
            type="button"
            class="cursor-pointer text-slate-500 hover:text-slate-700"
            @click="clearActivityFilters"
          >
            Clear
          </button>
        </div>
      </div>
      <ActivityFeed :actor="filterActor" :project="activityProject" :repo="activityRepo" height="24rem">
        <template #footer>
          <RouterLink
            :to="{ name: 'activity', query: { after: activitySinceThirtyDays } }"
            class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            See all activities →
          </RouterLink>
        </template>
      </ActivityFeed>
    </section>
  </main>
</template>

<style scoped>
/* Wave sheen on the compound bars — a translucent highlight band
   sweeps left-to-right across each colored bar on a staggered loop,
   so the top-5 list reads as alive rather than static. The overlay
   only covers the colored portion (the fill div, not the grey
   track), so quiet repos with short bars get a proportionally
   shorter sweep. Disabled under prefers-reduced-motion. */
.wave-fill {
  position: relative;
  overflow: hidden;
}
.wave-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.55) 50%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-100%);
  animation: bar-wave 2.8s ease-in-out infinite;
  animation-delay: calc(var(--wave-i, 0) * 0.22s);
}
@keyframes bar-wave {
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
@media (prefers-reduced-motion: reduce) {
  .wave-fill::after {
    animation: none;
    display: none;
  }
}
</style>
