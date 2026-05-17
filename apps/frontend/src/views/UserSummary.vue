<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useUserSummaryStore } from '@/stores/userSummary';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';

const route = useRoute();
const store = useUserSummaryStore();
const stats = useStatsStore();

const userId = computed(() => Number(route.params.userId));
const summary = computed(() => store.byUserId[userId.value]);
const loading = computed(() => store.loading[userId.value] === true);
const error = computed(() => store.error[userId.value] ?? null);

onMounted(() => {
  void store.fetch(userId.value);
  // Stats store carries the full repo list, which powers the project +
  // repo dropdowns below. The Dashboard already fetches this, but a
  // user landing on /users/:userId via a deep link needs it explicitly.
  void stats.fetchOverview();
});
watch(userId, (next) => void store.fetch(next));

// 30-day cutoff as YYYY-MM-DD for the "See all activities →" link
// below. Matches the Activity page's range-preset detection so the
// title chip lights up "[Last 30 days]" on landing.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));

// Project + repo filters narrow this user's activity feed. User is
// pinned (the page subject), so we don't render a user dropdown. The
// composable handles the project↔repo interlock — picking either one
// keeps the other coherent.
const {
  projectModel: filterProject,
  repoModel: filterRepo,
  repoOptions: repoFilterOptions,
} = useActivityFilters({
  repositories: computed(() => stats.repositories),
});
const projectOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const r of stats.repositories) if (r.project !== null) set.add(r.project);
  return Array.from(set).sort();
});
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 text-3xl font-bold tracking-tight text-slate-900">
        {{ summary?.user.displayName ?? `User #${userId}` }}
      </h1>
      <!-- Prefer the git-author email when we have one — more useful for
           humans recognizing / contacting the contributor than the opaque
           BB UUID. Fall back to the UUID when email is null (user predates
           the column / no parseable address landed yet). Email runs in the
           regular font; UUID stays monospaced since it's an identifier. -->
      <p v-if="summary?.user.email" class="mt-1 text-xs text-slate-400">{{ summary.user.email }}</p>
      <p v-else-if="summary" class="mt-1 font-mono text-xs text-slate-400">{{ summary.user.bitbucketUuid }}</p>
    </header>

    <p v-if="loading && !summary" class="text-sm text-slate-400">Loading…</p>
    <p v-if="error" class="mb-4 text-sm text-red-600">Could not load summary: {{ error }}</p>

    <template v-if="summary">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Commits — last 7 days" :value="summary.totals.commits7d" />
        <StatCard label="Commits — last 30 days" :value="summary.totals.commits30d" />
        <StatCard label="Commits — all time" :value="summary.totals.commitsAllTime" />
        <StatCard label="Repositories — all time" :value="summary.totals.repositoriesAllTime ?? 0" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity — last 365 days</h2>
        <CommitHeatmap :data="summary.dailyCommits" scope="user" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Top repos — last 30 days</h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table v-if="summary.topRepos.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="w-8 px-2 py-2 text-center font-medium"><span class="sr-only">Sync state</span></th>
                <th class="px-4 py-2 text-left font-medium">Repository</th>
                <th class="px-4 py-2 text-left font-medium">Project</th>
                <th colspan="3" class="py-2 pl-1 pr-4 text-right font-medium">Changes</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in summary.topRepos" :key="r.fullName">
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
                <!-- Adds/Dels columns. Excludes merge commits. Read
                     zero on rows whose diff-stats haven't been
                     ingested yet — transient state the backfill tick
                     chases by freshness-first global pickup. File
                     count is intentionally NOT surfaced as an
                     aggregate — SUM(files_changed) across many
                     commits double-counts the same path edited
                     repeatedly. Per-commit file count still appears
                     in the activity feed where it's the actual count
                     for that single commit. -->
                <td class="w-20 px-1 py-2 text-right text-xs tabular-nums">
                  <span class="text-emerald-700">+{{ r.additions30d.toLocaleString() }}</span>
                </td>
                <td class="w-20 px-1 py-2 text-right text-xs tabular-nums">
                  <span class="text-rose-700">−{{ r.deletions30d.toLocaleString() }}</span>
                </td>
                <td class="w-28 whitespace-nowrap py-2 pl-4 pr-4 text-right text-slate-500">
                  {{ r.commits.toLocaleString() }} commit<span v-if="r.commits !== 1">s</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No repos in the last 30 days.</p>
        </div>
      </section>

      <section class="mt-8">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
          <!-- Project + repo filters scoped to this user. User is pinned
               via `:actor` on the feed below, so it isn't a dropdown
               here. The composable wires the project↔repo interlock. -->
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <label for="user-filter-project" class="flex items-center gap-1">
              <span class="text-slate-500">Project:</span>
              <select
                id="user-filter-project"
                v-model="filterProject"
                name="user-filter-project"
                class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
                aria-label="Filter by project"
              >
                <option :value="undefined">All</option>
                <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
            <label for="user-filter-repo" class="flex items-center gap-1">
              <span class="text-slate-500">Repository:</span>
              <select
                id="user-filter-repo"
                v-model="filterRepo"
                name="user-filter-repo"
                class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
                aria-label="Filter by repository"
              >
                <option :value="undefined">All</option>
                <option v-for="r in repoFilterOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
              </select>
            </label>
          </div>
        </div>
        <ActivityFeed :actor="userId" :project="filterProject" :repo="filterRepo" height="24rem">
          <template #footer>
            <!-- "See all activities →" pre-applies this user so the
                 dedicated /activity page lands on the same scope. -->
            <RouterLink
              :to="{ name: 'activity', query: { actor: userId, after: activitySinceThirtyDays } }"
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
