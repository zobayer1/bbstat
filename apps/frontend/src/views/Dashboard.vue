<script setup lang="ts">
import { computed, onMounted } from 'vue';
import StatCard from '@/components/StatCard.vue';
import { useStatsStore } from '@/stores/stats';

const stats = useStatsStore();

onMounted(() => {
  void stats.fetchOverview();
});

const repos = computed(() => stats.overview?.repositories ?? '—');
const projects = computed(() => stats.overview?.projects ?? '—');
const developers = computed(() => stats.overview?.users ?? '—');
const lastSyncLabel = computed(() => {
  if (!stats.lastSyncedAt) return 'never';
  return new Date(stats.lastSyncedAt).toLocaleString();
});
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6 flex items-baseline justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">BBSTAT Dashboard</h1>
        <p class="mt-1 text-sm text-slate-500">Organization-wide BitBucket contribution statistics.</p>
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
    </section>

    <p v-if="stats.error" class="mt-4 text-sm text-red-600">Could not load stats: {{ stats.error }}</p>
  </main>
</template>
