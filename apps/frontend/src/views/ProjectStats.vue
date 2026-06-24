<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import Breadcrumb from '@/components/Breadcrumb.vue';
import { GLYPHS } from '@/lib/glyphs';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import ActorPicker from '@/components/ActorPicker.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import Sparkline from '@/components/Sparkline.vue';
import { useProjectStatsStore } from '@/stores/projectStats';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import { useActorFilter } from '@/composables/useActorFilter';

const route = useRoute();
const store = useProjectStatsStore();
const globalStats = useStatsStore();

const projectKey = computed(() => String(route.params.projectKey));
const stats = computed(() => store.byProjectKey[projectKey.value]);
const loading = computed(() => store.loading[projectKey.value] === true);
const error = computed(() => store.error[projectKey.value] ?? null);

onMounted(() => {
  void store.fetch(projectKey.value);
  // Feeds the repo dropdown; a deep link won't have a prior fetch.
  void globalStats.fetchOverview();
});
watch(projectKey, (next) => {
  repositoriesPage.value = 1;
  void store.fetch(next);
});

// Project is pinned via route params → repo + user filter only. Repo
// dropdown is auto-trimmed to this project via `pinProject`.
const { repoModel: filterRepo, repoOptions: repoFilterOptions } = useActivityFilters({
  repositories: computed(() => globalStats.repositories),
  pinProject: () => projectKey.value,
});

// Workspace for the "View on BitBucket" header link. Single-workspace
// deployment and a BB project lives in exactly one workspace, so the
// first repo's workspace is canonical.
const projectWorkspace = computed(() => stats.value?.repositories[0]?.workspace);

// 30-day cutoff for the "See all activities →" link; matches the Activity
// page's preset detection so the "[Last 30 days]" chip lights up.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));
const filterActor = useActorFilter();

const formatLastCommit = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString());

// Backend already sorts by `last_commit_at DESC NULLS LAST`, so this slice
// is freshness-ordered with no client-side reshaping.
const PAGE_SIZE = 10;
const repositoriesPage = ref(1);
const repositoriesPageCount = computed(() =>
  Math.max(1, Math.ceil((stats.value?.repositories.length ?? 0) / PAGE_SIZE)),
);
// Clamp when the list shrinks so the template can't index out of range.
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
      <Breadcrumb
        :items="[
          { label: 'Projects', to: '/projects', icon: GLYPHS.rectangleStack },
          { label: projectKey, bracketed: true },
        ]"
      />
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">{{ projectKey }}</h1>
        <!-- BB project link; hidden until the workspace is known. -->
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
        <StatCard label="Active contributors — 30d" :value="stats.totals.contributorCount30d" />
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

      <!-- Project-scoped contributor table: sparkline + diff stats
           aggregate across every repo in this project; sparkline excludes
           merge commits. -->
      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Contributors — last 30 days</h2>
        <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
          <ul v-if="stats.topContributors.length > 0" class="divide-y divide-slate-100">
            <li v-for="(c, i) in stats.topContributors" :key="`${c.entityKind}:${c.entityId}`">
              <!-- Person rows → /people/:id, user rows → /users/:id. -->
              <RouterLink
                :to="
                  c.entityKind === 'person'
                    ? { name: 'person', params: { personId: c.entityId } }
                    : { name: 'user', params: { userId: c.entityId } }
                "
                class="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <div class="flex min-w-0 items-center gap-3">
                  <span class="w-5 shrink-0 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
                  <span class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900">
                    <span class="truncate" :title="c.displayName">{{ c.displayName }}</span>
                    <span
                      v-if="c.entityKind === 'person' && c.attachedUserIds.length > 1"
                      class="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                      :title="`Merged from ${c.attachedUserIds.length} BitBucket accounts`"
                    >
                      ×{{ c.attachedUserIds.length }}
                    </span>
                  </span>
                </div>
                <div class="flex shrink-0 items-center gap-3">
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
          <!-- Project pinned by route → repo filter (auto-trimmed) + user filter. -->
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
              <span class="text-slate-500">Contributor:</span>
              <ActorPicker id="project-filter-user" v-model="filterActor" />
            </label>
          </div>
        </div>
        <ActivityFeed :project="projectKey" :repo="filterRepo" :actor="filterActor" height="24rem">
          <template #footer>
            <!-- Pre-applies this project on /activity. -->
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
