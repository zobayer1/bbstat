<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useUserSummaryStore } from '@/stores/userSummary';

const route = useRoute();
const store = useUserSummaryStore();

const userId = computed(() => Number(route.params.userId));
const summary = computed(() => store.byUserId[userId.value]);
const loading = computed(() => store.loading[userId.value] === true);
const error = computed(() => store.error[userId.value] ?? null);

onMounted(() => void store.fetch(userId.value));
watch(userId, (next) => void store.fetch(next));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 text-3xl font-bold tracking-tight text-slate-900">
        {{ summary?.user.displayName ?? `User #${userId}` }}
      </h1>
      <p v-if="summary" class="mt-1 font-mono text-xs text-slate-400">{{ summary.user.bitbucketUuid }}</p>
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
        <CommitHeatmap :data="summary.dailyCommits" />
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
                <th colspan="4" class="py-2 pl-1 pr-4 text-right font-medium">Changes</th>
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
                <!-- Adds/Dels/Files columns: render numbers only for
                     diff-stats-opted-in repos. Non-opted-in repos leave
                     the cell blank — the auto-opt-in rollout means
                     absence here is a temporary state, not a meaningful
                     "no data" signal worth visual weight. Excludes
                     merge commits. -->
                <td class="w-20 px-1 py-2 text-right text-xs tabular-nums">
                  <span v-if="r.diffStatsEnabled" class="text-emerald-700">+{{ r.additions30d.toLocaleString() }}</span>
                </td>
                <td class="w-20 px-1 py-2 text-right text-xs tabular-nums">
                  <span v-if="r.diffStatsEnabled" class="text-rose-700">−{{ r.deletions30d.toLocaleString() }}</span>
                </td>
                <td class="w-24 px-1 py-2 text-right text-xs tabular-nums">
                  <span v-if="r.diffStatsEnabled" class="text-slate-700"
                    >{{ r.filesChanged30d.toLocaleString() }} file<span v-if="r.filesChanged30d !== 1">s</span></span
                  >
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
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity</h2>
        <ActivityFeed :actor="userId" height="24rem" />
      </section>
    </template>
  </main>
</template>
