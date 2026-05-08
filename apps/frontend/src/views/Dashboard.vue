<script setup lang="ts">
import { computed, onMounted } from 'vue';
import StatCard from '@/components/StatCard.vue';
import { useStatsStore } from '@/stores/stats';
import type { ContributorWindow } from '@/api/client';

const stats = useStatsStore();

onMounted(() => {
  void stats.fetchOverview();
});

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
              <span class="text-sm font-medium text-slate-900">{{ c.displayName }}</span>
            </div>
            <span class="text-sm text-slate-500">{{ c.commits }} commits</span>
          </li>
        </ul>
        <p v-else class="px-4 py-6 text-center text-sm text-slate-400">
          No commits in the {{ windowLabel(stats.contributorsWindow).toLowerCase() }}.
        </p>
      </div>
    </section>

    <p v-if="stats.error" class="mt-4 text-sm text-red-600">Could not load stats: {{ stats.error }}</p>
  </main>
</template>
