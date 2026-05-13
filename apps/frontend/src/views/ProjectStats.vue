<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import { useProjectStatsStore } from '@/stores/projectStats';

const route = useRoute();
const store = useProjectStatsStore();

const projectKey = computed(() => String(route.params.projectKey));
const stats = computed(() => store.byProjectKey[projectKey.value]);
const loading = computed(() => store.loading[projectKey.value] === true);
const error = computed(() => store.error[projectKey.value] ?? null);

onMounted(() => void store.fetch(projectKey.value));
watch(projectKey, (next) => void store.fetch(next));

const formatLastCommit = (iso: string | null): string => (iso === null ? '—' : new Date(iso).toLocaleString());
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 text-3xl font-bold tracking-tight text-slate-900">{{ projectKey }}</h1>
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

      <section class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 class="mb-3 text-lg font-semibold text-slate-900">Last 12 weeks</h2>
          <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
            <ul v-if="stats.weeklyCommits.length > 0" class="divide-y divide-slate-100">
              <li
                v-for="w in stats.weeklyCommits"
                :key="w.weekStart"
                class="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span class="font-mono text-slate-500">Week of {{ w.weekStart }}</span>
                <span class="text-slate-900">{{ w.commits }} commits</span>
              </li>
            </ul>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No commits in the last 12 weeks.</p>
          </div>
        </div>

        <div>
          <h2 class="mb-3 text-lg font-semibold text-slate-900">Top contributors — last 30 days</h2>
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
                <span class="text-sm text-slate-500">{{ c.commits }} commits</span>
              </li>
            </ul>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No contributors in the last 30 days.</p>
          </div>
        </div>
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Repositories</h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="px-4 py-2 text-left font-medium">Repository</th>
                <th class="px-4 py-2 text-right font-medium">Commits — 30d</th>
                <th class="px-4 py-2 text-right font-medium">Last commit</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in stats.repositories" :key="r.fullName">
                <td class="px-4 py-2">
                  <RouterLink
                    :to="{ name: 'repository', params: { workspace: r.workspace, slug: r.slug } }"
                    class="font-medium text-slate-900 hover:text-slate-600"
                  >
                    {{ r.slug }}
                  </RouterLink>
                </td>
                <td class="px-4 py-2 text-right text-slate-900">{{ r.commits30d }}</td>
                <td class="px-4 py-2 text-right text-slate-500">{{ formatLastCommit(r.lastCommitAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity</h2>
        <ActivityFeed :project="projectKey" height="24rem" />
      </section>
    </template>
  </main>
</template>
