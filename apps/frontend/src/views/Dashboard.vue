<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import Sparkline from '@/components/Sparkline.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
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
const lastSyncLabel = computed(() => {
  if (!stats.lastSyncedAt) return 'never';
  return new Date(stats.lastSyncedAt).toLocaleString();
});

const windows: ContributorWindow[] = ['7d', '30d'];
const windowLabel = (w: ContributorWindow) => (w === '7d' ? 'Last 7 days' : 'Last 30 days');

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
// in component state (not the store) so it resets per visit; default size of
// 20 matches typical org/project list density and keeps the page tall enough
// to scan without scrolling forever.
const PAGE_SIZE = 20;
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
      <StatCard label="Developers" :value="developers" hint="Workspace members" />
      <StatCard label="Commits (all-time)" :value="totalCommits" />
      <StatCard label="Commits last 7 days" :value="commitsLast7Days" hint="Recent activity" />
    </section>

    <section class="mt-8">
      <div class="mb-3 flex items-baseline justify-between">
        <h2 class="text-lg font-semibold text-slate-900">Top contributors</h2>
        <div class="flex gap-2 text-xs">
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
      </div>

      <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
        <ul v-if="stats.topContributors.length > 0" class="divide-y divide-slate-100">
          <li
            v-for="(c, i) in stats.topContributors"
            :key="c.bitbucketUuid"
            class="flex items-center justify-between px-4 py-3"
          >
            <div class="flex items-center gap-3">
              <span class="w-5 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
              <RouterLink
                :to="{ name: 'user', params: { userId: c.userId } }"
                class="text-sm font-medium text-slate-900 hover:text-slate-600"
              >
                {{ c.displayName }}
              </RouterLink>
            </div>
            <div class="flex items-center gap-3">
              <Sparkline :points="c.last30Days" :width="64" :height="16" class="text-slate-400" />
              <span class="w-24 text-right text-sm text-slate-500">{{ c.commits }} commits</span>
            </div>
          </li>
        </ul>
        <p v-else class="px-4 py-6 text-center text-sm text-slate-400">
          No commits in the {{ windowLabel(stats.contributorsWindow).toLowerCase() }}.
        </p>
      </div>
    </section>

    <section class="mt-8">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
        <button
          v-if="filtersActive"
          type="button"
          class="text-xs text-slate-500 hover:text-slate-700"
          @click="clearFilters"
        >
          Clear filters
        </button>
      </div>

      <div class="mb-3 flex flex-wrap gap-2 text-xs">
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
      </div>

      <ActivityFeed :actor="filterActor" :repo="filterRepo" :project="filterProject" />
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
              <th class="px-4 py-2 text-left font-medium">Repository</th>
              <th class="px-4 py-2 text-left font-medium">Project</th>
              <th class="px-4 py-2 text-right font-medium">Commits 30d</th>
              <th class="px-4 py-2 text-right font-medium">Contributors 30d</th>
              <th class="px-4 py-2 text-right font-medium">Last commit</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr v-for="r in pagedRepositories" :key="r.fullName">
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
          </div>
        </div>
      </div>
    </section>

    <p v-if="stats.error" class="mt-4 text-sm text-red-600">Could not load stats: {{ stats.error }}</p>
  </main>
</template>
