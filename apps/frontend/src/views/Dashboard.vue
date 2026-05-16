<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import Sparkline from '@/components/Sparkline.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useStatsStore } from '@/stores/stats';
import type { ContributorWindow } from '@/api/client';

const stats = useStatsStore();
const route = useRoute();
const router = useRouter();

onMounted(() => {
  void stats.fetchOverview();
});

// Filter state is URL-synced (router.replace, no history entries) so deep
// links work — e.g. /?actor=42&repo=tigerit/foo lands on a pre-filtered
// view. Bare values get omitted from the query string when cleared.
function setQueryParam(key: string, value: string | number | undefined) {
  const next = { ...route.query };
  if (value === undefined || value === '') delete next[key];
  else next[key] = String(value);
  void router.replace({ query: next });
}

const filterActor = computed<number | undefined>({
  get: () => (route.query.actor !== undefined ? Number(route.query.actor) : undefined),
  set: (v) => setQueryParam('actor', v),
});
const filterRepo = computed<string | undefined>({
  get: () => (typeof route.query.repo === 'string' ? route.query.repo : undefined),
  set: (v) => setQueryParam('repo', v),
});
const filterProject = computed<string | undefined>({
  get: () => (typeof route.query.project === 'string' ? route.query.project : undefined),
  set: (v) => setQueryParam('project', v),
});

const filtersActive = computed(
  () => filterActor.value !== undefined || filterRepo.value !== undefined || filterProject.value !== undefined,
);

function clearFilters() {
  const next = { ...route.query };
  delete next.actor;
  delete next.repo;
  delete next.project;
  void router.replace({ query: next });
}

const repos = computed(() => stats.overview?.repositories ?? '—');
const projects = computed(() => stats.overview?.projects ?? '—');
const developers = computed(() => stats.overview?.users ?? '—');
const totalCommits = computed(() => stats.overview?.totalCommits ?? '—');
const commitsLast7Days = computed(() => stats.overview?.commitsLast7Days ?? '—');
const commitsLast30Days = computed(() => stats.overview?.commitsLast30Days ?? '—');
const lastSyncLabel = computed(() => {
  if (!stats.lastSyncedAt) return 'never';
  return new Date(stats.lastSyncedAt).toLocaleString();
});

const windows: ContributorWindow[] = ['7d', '30d'];
const windowLabel = (w: ContributorWindow) => (w === '7d' ? 'Last 7 days' : 'Last 30 days');

// Denominator for the per-contributor share bar — total commits across the
// whole workspace in the active window. Falls back to 0 when overview hasn't
// landed yet; the bar guards with `share === 0 ? 0 : ...` so the unfilled
// track still renders cleanly.
const windowTotalCommits = computed(() =>
  stats.contributorsWindow === '7d'
    ? (stats.overview?.commitsLast7Days ?? 0)
    : (stats.overview?.commitsLast30Days ?? 0),
);
const contributorShare = (commits: number): number => {
  const total = windowTotalCommits.value;
  if (total <= 0) return 0;
  return Math.min(100, (commits / total) * 100);
};

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

// Collapsed by default — tracked-set listings can be long. Pagination lives
// in component state (not the store) so it resets per visit; 10 rows per
// page keeps the panels visually compact even when fully expanded.
const PAGE_SIZE = 10;
const projectsExpanded = ref(false);
const repositoriesExpanded = ref(false);
const projectsPage = ref(1);
const repositoriesPage = ref(1);

const projectsPageCount = computed(() => Math.max(1, Math.ceil(projectsPanel.value.length / PAGE_SIZE)));
const repositoriesPageCount = computed(() => Math.max(1, Math.ceil(stats.repositories.length / PAGE_SIZE)));

// Clamp current page when the underlying list shrinks (e.g., a re-sync drops
// a repo). Use computed-with-write semantics so the template doesn't have to
// worry about out-of-range indices mid-render.
const projectsPageClamped = computed(() => Math.min(projectsPage.value, projectsPageCount.value));
const repositoriesPageClamped = computed(() => Math.min(repositoriesPage.value, repositoriesPageCount.value));

const pagedProjects = computed(() => {
  const start = (projectsPageClamped.value - 1) * PAGE_SIZE;
  return projectsPanel.value.slice(start, start + PAGE_SIZE);
});

const pagedRepositories = computed(() => {
  const start = (repositoriesPageClamped.value - 1) * PAGE_SIZE;
  return stats.repositories.slice(start, start + PAGE_SIZE);
});
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6 flex items-baseline justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">ShipShow!</h1>
        <p class="mt-1 text-sm text-slate-500">Part show, part shitshow.</p>
      </div>
      <div class="text-xs text-slate-400">
        <span v-if="stats.loading">Refreshing…</span>
        <span v-else>Last synced: {{ lastSyncLabel }}</span>
      </div>
    </header>

    <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard label="Tracked repositories" :value="repos" />
      <StatCard label="Projects" :value="projects" />
      <RouterLink
        :to="{ name: 'members' }"
        class="block rounded-lg transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        <StatCard label="Workspace Members" :value="developers" hint="Browse all →" />
      </RouterLink>
      <StatCard label="Commits (all-time)" :value="totalCommits" />
      <StatCard label="Commits last 7 days" :value="commitsLast7Days" hint="Recent activity" />
      <StatCard label="Commits last 30 days" :value="commitsLast30Days" hint="Trailing month" />
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
          <label class="flex items-center gap-1">
            <span class="text-slate-500">Project:</span>
            <select
              v-model="filterProject"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by project"
            >
              <option :value="undefined">All</option>
              <option v-for="p in projectsPanel" :key="p.projectKey" :value="p.projectKey">{{ p.projectKey }}</option>
            </select>
          </label>
          <label class="flex items-center gap-1">
            <span class="text-slate-500">Repository:</span>
            <select
              v-model="filterRepo"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by repository"
            >
              <option :value="undefined">All</option>
              <option v-for="r in stats.repositories" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
            </select>
          </label>
          <label class="flex items-center gap-1">
            <span class="text-slate-500">User:</span>
            <select
              v-model.number="filterActor"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter by user"
            >
              <option :value="undefined">All</option>
              <option v-for="c in stats.topContributors" :key="c.userId" :value="c.userId">{{ c.displayName }}</option>
            </select>
          </label>
          <button v-if="filtersActive" type="button" class="text-slate-500 hover:text-slate-700" @click="clearFilters">
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
            <li v-for="(c, i) in stats.topContributors" :key="c.bitbucketUuid">
              <!-- Whole row is one link target — `group` lives on the
                   RouterLink so descendant `group-hover:*` variants still
                   match on hover, and the row gets a soft slate-50 wash so
                   it reads as clickable everywhere, not just on the name. -->
              <RouterLink
                :to="{ name: 'user', params: { userId: c.userId } }"
                class="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <span class="w-5 shrink-0 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
                <span class="w-48 shrink-0 truncate text-sm font-medium text-slate-900" :title="c.displayName">
                  {{ c.displayName }}
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
                <!-- Share bar: this contributor's commits over the workspace
                   total in the active window. Gradient `blue-200 → blue-700`
                   covers the FULL track (so position-in-track determines the
                   shade — left = light, right = deep, regardless of fill
                   width), and a `bg-slate-100` overlay masks the unfilled
                   right portion. The `share-bar-sheen` overlay animates a
                   left→right highlight once per row-hover activation. -->
                <div
                  class="relative h-6 min-w-0 flex-1 overflow-hidden rounded-sm bg-gradient-to-r from-blue-200 to-blue-700"
                  :title="`${c.commits} of ${windowTotalCommits} (${contributorShare(c.commits).toFixed(1)}%)`"
                  :aria-label="`${contributorShare(c.commits).toFixed(1)}% of workspace commits`"
                >
                  <div
                    class="absolute right-0 top-0 h-full bg-slate-100"
                    :style="{ width: 100 - contributorShare(c.commits) + '%' }"
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
                <span class="w-24 shrink-0 text-right text-sm text-slate-500">{{ c.commits }} commits</span>
              </RouterLink>
            </li>
          </ul>
          <p v-else class="px-4 py-6 text-center text-sm text-slate-400">
            No commits in the {{ windowLabel(stats.contributorsWindow).toLowerCase() }}.
          </p>
        </div>
      </div>

      <!-- Activity tab — same height cap so the surrounding layout doesn't
           shift when switching tabs. v-show keeps the component mounted, so
           any filter state / loaded pages stay live across tab toggles. -->
      <div v-show="activeTab === 'activity'" role="tabpanel">
        <ActivityFeed
          :actor="filterActor"
          :repo="filterRepo"
          :project="filterProject"
          :height="ACTIVITY_PANEL_HEIGHT"
        />
      </div>
    </section>

    <section class="mt-8">
      <button
        type="button"
        class="mb-3 flex w-full items-center gap-2 text-left"
        :aria-expanded="projectsExpanded"
        aria-controls="projects-panel"
        @click="projectsExpanded = !projectsExpanded"
      >
        <span class="inline-block w-4 text-slate-400" aria-hidden="true">{{ projectsExpanded ? '▾' : '▸' }}</span>
        <h2 class="text-lg font-semibold text-slate-900">Projects</h2>
        <span class="text-sm text-slate-400">({{ projectsPanel.length }})</span>
      </button>

      <div
        v-show="projectsExpanded"
        id="projects-panel"
        class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <table v-if="projectsPanel.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th class="px-4 py-2 text-left font-medium">Project</th>
              <th class="px-4 py-2 text-right font-medium">Repos</th>
              <th class="px-4 py-2 text-right font-medium">Commits 30d</th>
              <th class="px-4 py-2 text-right font-medium">Last activity</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="p in pagedProjects" :key="p.projectKey">
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
              <td class="px-4 py-2 text-right text-slate-500">{{ formatLastCommit(p.lastActivity) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No projects with tracked repositories.</p>

        <div
          v-if="projectsPanel.length > PAGE_SIZE"
          class="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500"
        >
          <span>Page {{ projectsPageClamped }} of {{ projectsPageCount }}</span>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="projectsPageClamped <= 1"
              @click="projectsPage = projectsPageClamped - 1"
            >
              Prev
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="projectsPageClamped >= projectsPageCount"
              @click="projectsPage = projectsPageClamped + 1"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="mt-8">
      <button
        type="button"
        class="mb-3 flex w-full items-center gap-2 text-left"
        :aria-expanded="repositoriesExpanded"
        aria-controls="repositories-panel"
        @click="repositoriesExpanded = !repositoriesExpanded"
      >
        <span class="inline-block w-4 text-slate-400" aria-hidden="true">{{ repositoriesExpanded ? '▾' : '▸' }}</span>
        <h2 class="text-lg font-semibold text-slate-900">Tracked repositories</h2>
        <span class="text-sm text-slate-400">({{ stats.repositories.length }})</span>
      </button>

      <div
        v-show="repositoriesExpanded"
        id="repositories-panel"
        class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        <table v-if="stats.repositories.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
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
            <tr v-for="r in pagedRepositories" :key="r.fullName">
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

        <div
          v-if="stats.repositories.length > PAGE_SIZE"
          class="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500"
        >
          <span>Page {{ repositoriesPageClamped }} of {{ repositoriesPageCount }}</span>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="repositoriesPageClamped <= 1"
              @click="repositoriesPage = 1"
            >
              First
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="repositoriesPageClamped <= 1"
              @click="repositoriesPage = repositoriesPageClamped - 1"
            >
              Prev
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="repositoriesPageClamped >= repositoriesPageCount"
              @click="repositoriesPage = repositoriesPageClamped + 1"
            >
              Next
            </button>
            <button
              type="button"
              class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="repositoriesPageClamped >= repositoriesPageCount"
              @click="repositoriesPage = repositoriesPageCount"
            >
              Last
            </button>
          </div>
        </div>
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
</style>
