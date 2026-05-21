<script setup lang="ts">
// /projects index page.
//
// Structurally a sibling of the per-project detail view (/projects/:key)
// without the 365-day heatmap — projects are small in count, so the
// page leads with the project list itself (searchable + paginated)
// followed by workspace-aggregate sections that contextualise where
// work is happening across the whole roster.
//
// Sections, top to bottom:
//   1. Project list (search + sort + 10/page) ⌗ sunburst (one card)
//   2. Top 10 repos + Top 10 contributors (side-by-side)
//   3. Activity feed (latest entries, height-capped, with a
//      "See all activities →" footer attached to the card)

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import ActivityFeed from '@/components/ActivityFeed.vue';
import SunburstRepoContributors from '@/components/SunburstRepoContributors.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { api, type RepoContributorBreakdown } from '@/api/client';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import { liveBus } from '@/lib/live';

const stats = useStatsStore();
const route = useRoute();
const router = useRouter();

// Workspace for the "View on BitBucket" header link. Derived from
// the first tracked repo — single-workspace deployment by design,
// so any row's workspace is canonical. Empty until stats land,
// which hides the link via v-if.
const workspace = computed(() => stats.repositories[0]?.workspace ?? '');

// Programmatic navigation when the user clicks anywhere on a project
// row (not just the project-name link). The cell-level `RouterLink`
// still owns the link semantics — middle-click / Ctrl-click on the
// name continues to open in a new tab natively. Same-route pushes
// are noops in vue-router, so the inner link firing followed by
// this handler doesn't cause double navigation.
function openProject(projectKey: string): void {
  void router.push({ name: 'project', params: { projectKey } });
}

const breakdown = ref<RepoContributorBreakdown[]>([]);
const breakdownLoading = ref(false);
const breakdownError = ref<string | null>(null);

// SSE wiring for the sunburst. The project list + side tables are
// driven by `stats` (already SSE-subscribed in its store), but the
// repo-contributor breakdown is fetched view-locally — keep it fresh
// here so a sync tick doesn't strand stale aggregates on screen.
const liveCleanups: Array<() => void> = [];

onMounted(() => {
  void stats.fetchOverview();
  void loadBreakdown();
  liveCleanups.push(liveBus.on('tick.commits.complete', () => void loadBreakdown()));
  liveCleanups.push(liveBus.on('repository.deleted', () => void loadBreakdown()));
  liveCleanups.push(liveBus.onFallback(() => void loadBreakdown()));
});

onUnmounted(() => {
  for (const off of liveCleanups) off();
  liveCleanups.length = 0;
});

async function loadBreakdown(): Promise<void> {
  breakdownLoading.value = true;
  breakdownError.value = null;
  try {
    breakdown.value = await api.repoContributorBreakdown({ windowDays: 30, topRepos: 15, topPerRepo: 5 });
  } catch (e) {
    breakdownError.value = e instanceof Error ? e.message : String(e);
  } finally {
    breakdownLoading.value = false;
  }
}

// Computed for "Last 7 days" cutoff used by the See-all-activities
// link, matching the Dashboard's "More →" footer on the activity tab.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceSevenDays = computed(() => localDateString(new Date(Date.now() - 7 * DAY_MS)));

// ---------------------------------------------------------------------------
// Project list — derived client-side from the repos list (same shape
// the Dashboard uses for its Projects panel). Searchable, sortable,
// 10-per-page. Anonymous / no-project repos are filtered out.
// ---------------------------------------------------------------------------

interface ProjectRow {
  projectKey: string;
  // Workspace pulled from the first repo we see in this project — BB
  // workspace is uniform within a tracked set today (single-workspace
  // deployment per CLAUDE.md), so picking any one is safe. Captured
  // here so the external-link icon can build the BB project URL
  // without an extra lookup.
  workspace: string;
  repoCount: number;
  commits30d: number;
  lastActivity: string | null;
}

const allProjects = computed<ProjectRow[]>(() => {
  const buckets = new Map<string, ProjectRow>();
  for (const r of stats.repositories) {
    if (r.project === null) continue;
    const cur = buckets.get(r.project) ?? {
      projectKey: r.project,
      workspace: r.workspace,
      repoCount: 0,
      commits30d: 0,
      lastActivity: null,
    };
    cur.repoCount++;
    cur.commits30d += r.commits30d;
    if (r.lastCommitAt !== null && (cur.lastActivity === null || r.lastCommitAt > cur.lastActivity)) {
      cur.lastActivity = r.lastCommitAt;
    }
    buckets.set(r.project, cur);
  }
  return Array.from(buckets.values());
});

const search = ref('');
type SortKey = 'projectKey' | 'repoCount' | 'commits30d' | 'lastActivity';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('commits30d');
const sortDir = ref<SortDir>('desc');

function toggleSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = key === 'projectKey' ? 'asc' : 'desc';
  }
  page.value = 1;
}

const filtered = computed<ProjectRow[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (q === '') return allProjects.value;
  return allProjects.value.filter((p) => p.projectKey.toLowerCase().includes(q));
});

const sorted = computed<ProjectRow[]>(() => {
  const list = filtered.value.slice();
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const key = sortKey.value;
  list.sort((a, b) => {
    if (key === 'projectKey') return a.projectKey.localeCompare(b.projectKey) * dir;
    if (key === 'lastActivity') {
      const av = a.lastActivity;
      const bv = b.lastActivity;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    }
    return (a[key] - b[key]) * dir;
  });
  return list;
});

const PAGE_SIZE = 10;
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)));
const pageClamped = computed(() => Math.min(page.value, pageCount.value));
const paged = computed<ProjectRow[]>(() => {
  const start = (pageClamped.value - 1) * PAGE_SIZE;
  return sorted.value.slice(start, start + PAGE_SIZE);
});

watch(search, () => {
  page.value = 1;
});

const sortIndicator = (key: SortKey): string => {
  if (sortKey.value !== key) return '';
  return sortDir.value === 'asc' ? ' ▲' : ' ▼';
};

// Split into two helpers so the "Last activity" cell can stack date
// above time in a smaller font — easier to scan a column of dates
// when the time stops competing with them for width.
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Side-by-side bottom tables
// ---------------------------------------------------------------------------

const topRepos = computed(() =>
  stats.repositories
    .slice()
    .sort((a, b) => b.commits30d - a.commits30d)
    .slice(0, 10),
);
const topContributors = computed(() => stats.topContributors.slice(0, 10));

// ---------------------------------------------------------------------------
// Activity-feed filters. Same set as the Dashboard's activity tab —
// project + repo (with interlock) + user — so the workspace-wide
// stream on this page can be narrowed without leaving the project
// index. URL-synced so deep links work and the Back button behaves.
// ---------------------------------------------------------------------------

function setQueryParam(key: string, value: string | number | undefined): void {
  const next = { ...route.query };
  if (value === undefined || value === '') delete next[key];
  else next[key] = String(value);
  void router.replace({ query: next });
}

const filterActor = computed<number | undefined>({
  get: () => (route.query.actor !== undefined ? Number(route.query.actor) : undefined),
  set: (v) => setQueryParam('actor', v),
});
const {
  projectModel: filterProject,
  repoModel: filterRepo,
  projectOptions: projectFilterOptions,
  repoOptions: repoFilterOptions,
} = useActivityFilters({
  repositories: computed(() => stats.repositories),
});

const filtersActive = computed(
  () => filterActor.value !== undefined || filterRepo.value !== undefined || filterProject.value !== undefined,
);

function clearFilters(): void {
  const next = { ...route.query };
  delete next.actor;
  delete next.repo;
  delete next.project;
  void router.replace({ query: next });
}
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">Projects</h1>
        <!-- Thin external link to BB's workspace-wide projects list.
             Hidden until stats land so the URL is never built from an
             empty workspace string. -->
        <a
          v-if="workspace"
          :href="`https://bitbucket.org/${workspace}/workspace/projects/`"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 text-xs text-slate-500 hover:text-blue-600"
          title="View on BitBucket"
        >
          View on BitBucket ↗
        </a>
      </div>
      <p class="mt-1 text-sm text-slate-500">Every BitBucket project we're tracking, with workspace-wide context.</p>
    </header>

    <!-- Project table + sunburst share a single bordered panel so the
         chart visually sits on the same surface as the list rather
         than looking like a separate widget. The outer grid is the
         "invisible section"; the inner divider line stands in for the
         column gutter. Heights stretch by default so the chart column
         fills whatever vertical space the table grew into. -->
    <section class="mb-8 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div class="grid grid-cols-1 lg:grid-cols-2 lg:divide-x lg:divide-slate-100">
        <!-- LEFT: search row + project table + pagination footer, all
             inside the shared card -->
        <div class="flex flex-col">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
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
                id="projects-search"
                v-model="search"
                type="search"
                name="projects-search"
                autocomplete="off"
                placeholder="Search projects…"
                class="w-64 rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
                aria-label="Search projects"
              />
            </div>
            <span class="text-xs text-slate-500">
              {{ sorted.length }}
              <span v-if="search.trim() !== ''">match<span v-if="sorted.length !== 1">es</span></span>
              <span v-else>project<span v-if="sorted.length !== 1">s</span></span>
            </span>
          </div>

          <div class="flex-1">
            <table v-if="paged.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
              <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th class="px-4 py-2 text-left font-medium">
                    <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('projectKey')">
                      Project{{ sortIndicator('projectKey') }}
                    </button>
                  </th>
                  <th class="px-4 py-2 text-right font-medium">
                    <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('repoCount')">
                      Repos{{ sortIndicator('repoCount') }}
                    </button>
                  </th>
                  <th class="px-4 py-2 text-right font-medium">
                    <button type="button" class="cursor-pointer hover:text-slate-700" @click="toggleSort('commits30d')">
                      Commits 30d{{ sortIndicator('commits30d') }}
                    </button>
                  </th>
                  <th class="px-4 py-2 text-right font-medium">
                    <button
                      type="button"
                      class="cursor-pointer hover:text-slate-700"
                      @click="toggleSort('lastActivity')"
                    >
                      Last activity{{ sortIndicator('lastActivity') }}
                    </button>
                  </th>
                  <th class="w-10 px-2 py-2 text-center font-medium">
                    <span class="sr-only">Open on BitBucket</span>
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr
                  v-for="p in paged"
                  :key="p.projectKey"
                  class="cursor-pointer hover:bg-slate-50"
                  @click="openProject(p.projectKey)"
                >
                  <td class="px-4 py-2">
                    <RouterLink
                      :to="{ name: 'project', params: { projectKey: p.projectKey } }"
                      class="font-medium text-slate-900 hover:text-slate-600"
                    >
                      {{ p.projectKey }}
                    </RouterLink>
                  </td>
                  <td class="px-4 py-2 text-right text-slate-900">{{ p.repoCount }}</td>
                  <td class="px-4 py-2 text-right text-slate-900">{{ p.commits30d }}</td>
                  <td class="px-4 py-2 text-right text-[10px] text-slate-500">
                    <template v-if="p.lastActivity !== null">
                      <div>{{ formatDate(p.lastActivity) }}</div>
                      <div class="text-slate-400">{{ formatTime(p.lastActivity) }}</div>
                    </template>
                    <span v-else>—</span>
                  </td>
                  <td class="px-2 py-2 text-center align-middle">
                    <!-- External BB project link. `@click.stop` keeps
                         the row-click handler from also firing (which
                         would push the in-app project detail on top
                         of opening BB in a new tab). -->
                    <a
                      :href="`https://bitbucket.org/${p.workspace}/workspace/projects/${p.projectKey}`"
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
            <p v-else-if="search.trim() !== ''" class="px-4 py-6 text-center text-sm text-slate-400">
              No projects match "{{ search }}".
            </p>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No tracked projects yet.</p>
          </div>

          <!-- Pagination pinned to the bottom of the LEFT column. Sits
             outside the table's stretching wrapper so it never floats
             mid-column when the chart pushes the row taller. -->
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
        </div>

        <!-- RIGHT: chart column. No card chrome of its own — the outer
           panel's bg / border / shadow already wraps it, dropping the
           inner card avoids the "widget within a widget" feel. Centred
           so the sunburst sits comfortably even when the table column
           grew taller than the chart. -->
        <div class="flex flex-col items-center justify-center px-6 py-2">
          <p v-if="breakdownError" class="mb-3 text-sm text-red-600">Could not load breakdown: {{ breakdownError }}</p>
          <p v-if="breakdownLoading && breakdown.length === 0" class="text-sm text-slate-400">Loading…</p>
          <SunburstRepoContributors v-else :data="breakdown" />
        </div>
      </div>
    </section>

    <!-- Top 10 repos + contributors side-by-side. Lifted above the
         activity feed: aggregate context first, then the chronological
         stream below it. -->
    <section class="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <h2
          class="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wider text-slate-500"
        >
          Top 10 repositories by commits · last 30 days
        </h2>
        <table v-if="topRepos.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
          <tbody class="divide-y divide-slate-100">
            <tr v-for="r in topRepos" :key="r.fullName" class="hover:bg-slate-50">
              <td class="w-6 px-2 py-2 text-center align-middle">
                <SyncStateIcon :status="r.syncStatus" />
              </td>
              <td class="px-3 py-2">
                <RouterLink
                  :to="{ name: 'repository', params: { workspace: r.workspace, slug: r.slug } }"
                  class="font-medium text-slate-900 hover:text-slate-600"
                >
                  {{ r.slug }}
                </RouterLink>
                <span v-if="r.project" class="ml-1 text-xs text-slate-400">{{ r.project }}</span>
              </td>
              <!-- {commits} ({contributors}) — mirrors the Members
                   table's `{commits} ({repos})` pattern: primary count
                   in slate-900, secondary count in parens at half scale
                   and slate-400 so the breadth metric reads as
                   supplementary context, not a competing number. -->
              <td class="px-3 py-2 text-right tabular-nums text-slate-900">
                {{ r.commits30d }}
                <span class="ml-1 text-xs font-normal text-slate-400">({{ r.contributors30d }})</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No tracked repositories.</p>
      </div>

      <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <h2
          class="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-medium uppercase tracking-wider text-slate-500"
        >
          Top 10 contributors by Momentum + Consistency
        </h2>
        <table v-if="topContributors.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
          <tbody class="divide-y divide-slate-100">
            <tr v-for="(c, i) in topContributors" :key="c.bitbucketUuid" class="hover:bg-slate-50">
              <td class="w-6 px-2 py-2 text-right font-mono text-xs text-slate-400">{{ i + 1 }}</td>
              <td class="px-3 py-2">
                <RouterLink
                  :to="{ name: 'user', params: { userId: c.userId } }"
                  class="font-medium text-slate-900 hover:text-slate-600"
                >
                  {{ c.displayName }}
                </RouterLink>
              </td>
              <!-- Momentum + Consistency, both right-aligned and visually
                   adjacent — tight inter-column padding (`pr-1` / `pl-1`)
                   so they read as one combined ranking signal. Momentum
                   is the primary metric in slate-900; Consistency is
                   diffused at slate-400, matching the "supplementary
                   context" treatment used in the {commits}({contributors})
                   cells in the Top 10 Repositories panel above. -->
              <td class="py-2 pl-3 pr-1 text-right tabular-nums text-slate-900">
                {{ c.momentum === null ? '—' : c.momentum.toFixed(1) }}
              </td>
              <td class="py-2 pl-1 pr-3 text-right text-xs tabular-nums text-slate-400">
                {{ c.consistency90d === null ? '—' : `${Math.round(c.consistency90d * 100)}%` }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No commits in the window.</p>
      </div>
    </section>

    <!-- Activity feed. Filters mirror the Dashboard activity tab —
         project / repo (interlocked) / user — so the workspace stream
         can be narrowed inline without bouncing to /activity. -->
    <section class="mb-8">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <label for="projects-activity-filter-project" class="flex items-center gap-1">
            <span class="text-slate-500">Project:</span>
            <select
              id="projects-activity-filter-project"
              v-model="filterProject"
              name="projects-activity-filter-project"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by project"
            >
              <option :value="undefined">All</option>
              <option v-for="p in projectFilterOptions" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label for="projects-activity-filter-repo" class="flex items-center gap-1">
            <span class="text-slate-500">Repository:</span>
            <select
              id="projects-activity-filter-repo"
              v-model="filterRepo"
              name="projects-activity-filter-repo"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by repository"
            >
              <option :value="undefined">All</option>
              <option v-for="r in repoFilterOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
            </select>
          </label>
          <label for="projects-activity-filter-user" class="flex items-center gap-1">
            <span class="text-slate-500">User:</span>
            <select
              id="projects-activity-filter-user"
              v-model.number="filterActor"
              name="projects-activity-filter-user"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by user"
            >
              <option :value="undefined">All</option>
              <option v-for="c in stats.topContributors" :key="c.userId" :value="c.userId">{{ c.displayName }}</option>
            </select>
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
      <ActivityFeed :actor="filterActor" :repo="filterRepo" :project="filterProject" height="24rem">
        <template #footer>
          <!-- "See all activities →" lives inside the feed's footer
               slot so it visually attaches to the activity card
               instead of floating loose below it. Mirrors the
               Dashboard activity tab's "More →" footer treatment. -->
          <RouterLink
            :to="{ name: 'activity', query: { after: activitySinceSevenDays } }"
            class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            See all activities →
          </RouterLink>
        </template>
      </ActivityFeed>
    </section>
  </main>
</template>
