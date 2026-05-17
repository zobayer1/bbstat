<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import Sparkline from '@/components/Sparkline.vue';
import { useProjectStatsStore } from '@/stores/projectStats';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';

const route = useRoute();
const router = useRouter();
const store = useProjectStatsStore();
const globalStats = useStatsStore();

const projectKey = computed(() => String(route.params.projectKey));
const stats = computed(() => store.byProjectKey[projectKey.value]);
const loading = computed(() => store.loading[projectKey.value] === true);
const error = computed(() => store.error[projectKey.value] ?? null);

onMounted(() => {
  void store.fetch(projectKey.value);
  // Stats store feeds the repo dropdown options below — a deep link
  // into /projects/:key won't have the dashboard's prior fetch.
  void globalStats.fetchOverview();
});
watch(projectKey, (next) => {
  // Reset pagination when navigating between projects.
  repositoriesPage.value = 1;
  void store.fetch(next);
});

// Project is pinned via route params, so we expose a repo + user filter
// pair only. The repo dropdown is auto-trimmed to this project's repos
// via the composable's `pinProject` option.
const { repoModel: filterRepo, repoOptions: repoFilterOptions } = useActivityFilters({
  repositories: computed(() => globalStats.repositories),
  pinProject: () => projectKey.value,
});

// User dropdown reads from the project's own top contributors — more
// relevant than the workspace-wide leaderboard.
const userOptions = computed(() => stats.value?.topContributors ?? []);

// Workspace of any repo in the project. Picking the first one is
// safe — the tracked set is single-workspace per deployment per
// CLAUDE.md, and a BB project always lives inside exactly one
// workspace anyway. Used to build the canonical BB project URL
// surfaced via the "View on BitBucket" link in the page header.
const projectWorkspace = computed(() => stats.value?.repositories[0]?.workspace);

// 30-day cutoff as YYYY-MM-DD for the "See all activities →" link.
// Matches the Activity page's range-preset detection so the title chip
// lights up "[Last 30 days]" on landing.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));
const filterActor = computed<number | undefined>({
  get: () => (route.query.actor !== undefined ? Number(route.query.actor) : undefined),
  set: (v) => {
    const next = { ...route.query };
    if (v === undefined) delete next.actor;
    else next.actor = String(v);
    void router.replace({ query: next });
  },
});

const formatLastCommit = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString());

// Pagination state for the repositories table. Backend already sorts by
// `last_commit_at DESC NULLS LAST`, so this slice presents pages in
// freshness order without any client-side reshaping.
const PAGE_SIZE = 10;
const repositoriesPage = ref(1);
const repositoriesPageCount = computed(() =>
  Math.max(1, Math.ceil((stats.value?.repositories.length ?? 0) / PAGE_SIZE)),
);
// Clamp current page when the underlying list shrinks — keeps the
// template safe from out-of-range indices mid-render.
const repositoriesPageClamped = computed(() => Math.min(repositoriesPage.value, repositoriesPageCount.value));
const pagedRepositories = computed(() => {
  const all = stats.value?.repositories ?? [];
  const start = (repositoriesPageClamped.value - 1) * PAGE_SIZE;
  return all.slice(start, start + PAGE_SIZE);
});
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">{{ projectKey }}</h1>
        <!-- Thin external link to the canonical BB project page —
             hidden until we know the workspace (the link is built
             from the first repo's workspace once stats land). -->
        <a
          v-if="projectWorkspace"
          :href="`https://bitbucket.org/${projectWorkspace}/workspace/projects/${projectKey}`"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 text-xs text-slate-500 hover:text-blue-600"
          title="View on BitBucket"
        >
          View on BitBucket ↗
        </a>
      </div>
      <p v-if="stats" class="mt-1 text-sm text-slate-500">{{ stats.totals.repositoryCount }} repositories tracked</p>
    </header>

    <p v-if="loading && !stats" class="text-sm text-slate-400">Loading…</p>
    <p v-if="error" class="mb-4 text-sm text-red-600">Could not load project: {{ error }}</p>

    <template v-if="stats">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Commits — last 7 days" :value="stats.totals.commits7d" />
        <StatCard label="Commits — last 30 days" :value="stats.totals.commits30d" />
        <StatCard label="Active contributors — 7d" :value="stats.totals.contributorCount7d" />
        <StatCard label="Repositories" :value="stats.totals.repositoryCount" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity — last 365 days</h2>
        <CommitHeatmap :data="stats.dailyCommits ?? []" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">
          Repositories <span class="text-sm font-normal text-slate-400">({{ stats.repositories.length }})</span>
        </h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table v-if="stats.repositories.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="w-8 px-2 py-2 text-center font-medium"><span class="sr-only">Sync state</span></th>
                <th class="px-4 py-2 text-left font-medium">Repository</th>
                <th class="px-4 py-2 text-right font-medium">Commits — 30d</th>
                <th class="px-4 py-2 text-right font-medium">Contributors — 30d</th>
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
                <td class="px-4 py-2 text-right text-slate-900">{{ r.commits30d }}</td>
                <td class="px-4 py-2 text-right text-slate-900">{{ r.contributors30d ?? 0 }}</td>
                <td class="px-4 py-2 text-right text-slate-500">{{ formatLastCommit(r.lastCommitAt) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No repositories in this project.</p>

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

      <!-- Contributor table — same layout as the per-repo Contributors
           list on RepoActivity.vue (rank · name · sparkline · adds /
           dels · commits). Data is project-scoped: sparkline + diff
           stats aggregate across every repo carrying this project's
           key. Sparkline excludes merge commits via the same NOT
           is_merge predicate used by the repo-page query. -->
      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Contributors — last 30 days</h2>
        <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
          <ul v-if="stats.topContributors.length > 0" class="divide-y divide-slate-100">
            <li v-for="(c, i) in stats.topContributors" :key="c.bitbucketUuid">
              <RouterLink
                :to="{ name: 'user', params: { userId: c.userId } }"
                class="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <div class="flex items-center gap-3">
                  <span class="w-5 shrink-0 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
                  <span class="text-sm font-medium text-slate-900">{{ c.displayName }}</span>
                </div>
                <div class="flex items-center gap-3">
                  <Sparkline
                    :points="c.last30Days ?? []"
                    :width="128"
                    :height="16"
                    class="shrink-0 text-slate-400 transition-colors group-hover:text-blue-600"
                  />
                  <div class="flex items-center gap-1">
                    <span class="w-20 shrink-0 text-right text-xs tabular-nums text-emerald-700">
                      +{{ c.additions30d.toLocaleString() }}
                    </span>
                    <span class="w-20 shrink-0 text-right text-xs tabular-nums text-rose-700">
                      −{{ c.deletions30d.toLocaleString() }}
                    </span>
                  </div>
                  <span class="w-24 shrink-0 text-right text-sm text-slate-500">{{ c.commits }} commits</span>
                </div>
              </RouterLink>
            </li>
          </ul>
          <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No contributors in the last 30 days.</p>
        </div>
      </section>

      <section class="mt-8">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
          <!-- Project is pinned by the route, so the user gets a repo
               filter (auto-trimmed to this project's repos by the
               composable) plus a user filter sourced from the project's
               own contributor list. -->
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <label for="project-filter-repo" class="flex items-center gap-1">
              <span class="text-slate-500">Repository:</span>
              <select
                id="project-filter-repo"
                v-model="filterRepo"
                name="project-filter-repo"
                class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
                aria-label="Filter by repository"
              >
                <option :value="undefined">All</option>
                <option v-for="r in repoFilterOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
              </select>
            </label>
            <label for="project-filter-user" class="flex items-center gap-1">
              <span class="text-slate-500">User:</span>
              <select
                id="project-filter-user"
                v-model.number="filterActor"
                name="project-filter-user"
                class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
                aria-label="Filter by user"
              >
                <option :value="undefined">All</option>
                <option v-for="u in userOptions" :key="u.userId" :value="u.userId">{{ u.displayName }}</option>
              </select>
            </label>
          </div>
        </div>
        <ActivityFeed :project="projectKey" :repo="filterRepo" :actor="filterActor" height="24rem">
          <template #footer>
            <!-- "See all activities →" pre-applies this project so the
                 dedicated /activity page lands on the same scope. -->
            <RouterLink
              :to="{ name: 'activity', query: { project: projectKey, after: activitySinceThirtyDays } }"
              class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              See all activities →
            </RouterLink>
          </template>
        </ActivityFeed>
      </section>
    </template>
  </main>
</template>
