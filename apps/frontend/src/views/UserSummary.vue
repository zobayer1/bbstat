<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import Breadcrumb from '@/components/Breadcrumb.vue';
import { GLYPHS } from '@/lib/glyphs';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import BadgeIcon from '@/components/BadgeIcon.vue';
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
  // Repo list powers the filter dropdowns; a deep link won't have a prior fetch.
  void stats.fetchOverview();
});
watch(userId, (next) => void store.fetch(next));

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

// "See all activities →" target. For a merged alias, zoom out to the
// canonical person — a merged alias has no standalone entry in the actor
// roster, so passing its raw user_id would surface "User #id".
const seeAllActivityQuery = computed<Record<string, string | number>>(() => {
  const person = summary.value?.user.person;
  const q: Record<string, string | number> = { after: activitySinceThirtyDays.value };
  if (person) {
    q.actor = person.id;
    q.actorKind = 'person';
  } else {
    q.actor = userId.value;
  }
  return q;
});

// Project + repo filters; user is pinned (no contributor dropdown). The
// composable owns the project↔repo interlock.
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

// Compact "time ago" for the Linked-accounts Last active column; "—" when none.
function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const diffSec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = diffSec / 60;
  if (diffMin < 60) return `${Math.round(diffMin)}m`;
  const diffHr = diffMin / 60;
  if (diffHr < 24) return `${Math.round(diffHr)}h`;
  const diffDay = diffHr / 24;
  if (diffDay < 14) return `${Math.round(diffDay)}d`;
  const diffWk = diffDay / 7;
  if (diffWk < 8) return `${Math.round(diffWk)}w`;
  const diffMo = diffDay / 30;
  if (diffMo < 12) return `${Math.round(diffMo)}mo`;
  return `${Math.round(diffDay / 365)}y`;
}
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <Breadcrumb
        :items="[
          { label: 'Members', to: '/members', icon: GLYPHS.users },
          { label: summary?.user.displayName ?? `User #${userId}`, bracketed: true },
        ]"
      />
      <div class="mt-1 flex items-center gap-3">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">
          {{ summary?.user.displayName ?? `User #${userId}` }}
        </h1>
        <BadgeIcon v-if="summary && summary.user.badge" :badge="summary.user.badge" :tier="summary.user.badgeTier" />
        <!-- When merged, the canonical person name links through to the person page. -->
        <RouterLink
          v-if="summary?.user.person"
          :to="{ name: 'person', params: { personId: summary.user.person.id } }"
          class="text-base font-medium text-violet-700 hover:text-violet-900 hover:underline"
          :title="`Part of merged person ${summary.user.person.displayName}`"
        >
          [{{ summary.user.person.displayName }}]
        </RouterLink>
      </div>
      <!-- Prefer the git-author email (more recognizable than the UUID),
           falling back to the monospaced UUID when email is null. -->
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
                <!-- Adds/Dels, merge commits excluded; zero until diff-stats
                     are ingested. File count is intentionally NOT aggregated
                     — SUM(files_changed) double-counts a repeatedly-edited
                     path (per-commit count still shows in the activity feed). -->
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

      <!-- Linked accounts — the OTHER aliases of the same person (this
           account excluded); only for a merged account. -->
      <section v-if="summary.user.person" class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Linked accounts</h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="px-4 py-2 text-left font-medium">Account</th>
                <th class="px-4 py-2 text-left font-medium">Email</th>
                <th class="px-4 py-2 text-left font-medium">BitBucket UUID</th>
                <th class="px-4 py-2 text-center font-medium">Last active</th>
                <th class="px-4 py-2 text-center font-medium">Primary</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="a in summary.linkedAccounts" :key="a.id" class="hover:bg-slate-50">
                <td class="px-4 py-2">
                  <RouterLink
                    :to="{ name: 'user', params: { userId: a.id } }"
                    class="font-medium text-slate-900 hover:text-slate-600"
                  >
                    {{ a.displayName }}
                  </RouterLink>
                  <span v-if="a.username" class="ml-1 text-xs text-slate-400">@{{ a.username }}</span>
                </td>
                <td class="px-4 py-2 text-slate-500">
                  <span v-if="a.email">{{ a.email }}</span>
                  <span v-else class="text-slate-300">—</span>
                </td>
                <td class="px-4 py-2 font-mono text-xs text-slate-400">{{ a.bitbucketUuid }}</td>
                <td class="px-4 py-2 text-center text-slate-500" :title="a.lastActiveAt ?? ''">
                  {{ relativeTime(a.lastActiveAt) }}
                </td>
                <td class="px-4 py-2 text-center">
                  <span
                    v-if="a.isPrimary"
                    class="inline-block rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                    >primary</span
                  >
                  <span v-else class="text-slate-300">—</span>
                </td>
              </tr>
              <tr v-if="summary.linkedAccounts.length === 0">
                <td colspan="5" class="px-4 py-6 text-center text-sm text-slate-400">No other linked accounts.</td>
              </tr>
            </tbody>
          </table>
          <RouterLink
            :to="{ name: 'person', params: { personId: summary.user.person.id } }"
            class="flex items-center justify-between gap-3 border-t border-slate-100 bg-violet-50 px-4 py-2.5 text-xs font-medium text-violet-800 transition hover:bg-violet-100"
          >
            <span>
              Part of the merged person
              <strong class="font-semibold">{{ summary.user.person.displayName }}</strong> — view the combined activity
              across all linked accounts.
            </span>
            <span class="shrink-0" aria-hidden="true">→</span>
          </RouterLink>
        </div>
      </section>

      <section class="mt-8">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
          <!-- Project + repo filters; user pinned via `:actor` below (no dropdown). -->
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
        <ActivityFeed :actor="{ kind: 'user', id: userId }" :project="filterProject" :repo="filterRepo" height="24rem">
          <template #footer>
            <!-- Pre-applies this contributor (merged alias → the person). -->
            <RouterLink
              :to="{ name: 'activity', query: seeAllActivityQuery }"
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
