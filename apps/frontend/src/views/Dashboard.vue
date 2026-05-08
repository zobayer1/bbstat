<script setup lang="ts">
import { computed } from 'vue';
import StatCard from '@/components/StatCard.vue';
import { useActivityStore } from '@/stores/activity';

const activity = useActivityStore();
const lastSync = computed(() => activity.lastSyncedAt ?? 'never');
const totalEntries = computed(() => activity.entries.length);
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight text-slate-900">BBSTAT Dashboard</h1>
      <p class="mt-1 text-sm text-slate-500">Organization-wide BitBucket contribution statistics.</p>
    </header>

    <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard label="Activity entries (cached)" :value="totalEntries" hint="Persisted in Pinia" />
      <StatCard label="Last sync" :value="lastSync" />
      <StatCard label="Auth" value="Open access" hint="BitBucket OAuth coming later" />
    </section>
  </main>
</template>
