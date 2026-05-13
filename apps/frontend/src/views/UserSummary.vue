<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
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
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Commits — last 7 days" :value="summary.totals.commits7d" />
        <StatCard label="Commits — last 30 days" :value="summary.totals.commits30d" />
        <StatCard label="Commits — all time" :value="summary.totals.commitsAllTime" />
      </section>

      <section class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 class="mb-3 text-lg font-semibold text-slate-900">Last 30 days</h2>
          <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
            <ul v-if="summary.dailyCommits.length > 0" class="divide-y divide-slate-100">
              <li
                v-for="d in summary.dailyCommits"
                :key="d.date"
                class="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span class="font-mono text-slate-500">{{ d.date }}</span>
                <span class="text-slate-900">{{ d.commits }}</span>
              </li>
            </ul>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No commits in the last 30 days.</p>
          </div>
        </div>

        <div>
          <h2 class="mb-3 text-lg font-semibold text-slate-900">Top repos — last 30 days</h2>
          <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <table v-if="summary.topRepos.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
              <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th class="px-4 py-2 text-left font-medium">Repository</th>
                  <th class="px-4 py-2 text-left font-medium">Project</th>
                  <th class="px-4 py-2 text-right font-medium">Commits</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                <tr v-for="r in summary.topRepos" :key="r.fullName">
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
                  <td class="px-4 py-2 text-right text-slate-900">{{ r.commits }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No repos in the last 30 days.</p>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity</h2>
        <ActivityFeed :actor="userId" />
      </section>
    </template>
  </main>
</template>
