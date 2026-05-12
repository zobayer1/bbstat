<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
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
          <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
            <ul v-if="summary.topRepos.length > 0" class="divide-y divide-slate-100">
              <li v-for="r in summary.topRepos" :key="r.fullName" class="flex items-center justify-between px-4 py-3">
                <RouterLink
                  :to="{ name: 'repository', params: { workspace: r.workspace, slug: r.slug } }"
                  class="text-sm font-medium text-slate-900 hover:text-slate-600"
                >
                  {{ r.fullName }}
                </RouterLink>
                <span class="text-sm text-slate-500">{{ r.commits }} commits</span>
              </li>
            </ul>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No repos in the last 30 days.</p>
          </div>
        </div>
      </section>
    </template>
  </main>
</template>
