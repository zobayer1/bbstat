<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import Sparkline from '@/components/Sparkline.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useRepoActivityStore } from '@/stores/repoActivity';

const route = useRoute();
const store = useRepoActivityStore();

const workspace = computed(() => String(route.params.workspace));
const slug = computed(() => String(route.params.slug));
const fullName = computed(() => `${workspace.value}/${slug.value}`);
const activity = computed(() => store.byFullName[fullName.value]);
const loading = computed(() => store.loading[fullName.value] === true);
const error = computed(() => store.error[fullName.value] ?? null);

// Sum over the full 365-day dailyCommits window the backend now ships.
const commits365d = computed(() => activity.value?.dailyCommits.reduce((acc, d) => acc + d.commits, 0) ?? 0);

onMounted(() => void store.fetch(workspace.value, slug.value));
watch([workspace, slug], () => void store.fetch(workspace.value, slug.value));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
        <span>{{ slug }}</span>
        <SyncStateIcon v-if="activity" :status="activity.repository.syncStatus" />
      </h1>
      <p v-if="activity" class="mt-1 text-sm text-slate-500">
        {{ commits365d }} commits · {{ activity.contributors.length }} contributors
      </p>
    </header>

    <p v-if="loading && !activity" class="text-sm text-slate-400">Loading…</p>
    <p v-if="error" class="mb-4 text-sm text-red-600">Could not load activity: {{ error }}</p>

    <template v-if="activity">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Commits — last 365 days" :value="commits365d" />
        <StatCard label="Active contributors — 30d" :value="activity.contributors.length" />
        <StatCard v-if="activity.diffStats" label="Code changes — last 7 days">
          <template #value>
            <span class="text-emerald-700">+{{ activity.diffStats.additions7d.toLocaleString() }}</span>
            <span class="ml-2 text-rose-700">−{{ activity.diffStats.deletions7d.toLocaleString() }}</span>
          </template>
          <template #hint>excludes merges</template>
        </StatCard>
        <StatCard v-if="activity.diffStats" label="Code changes — last 30 days">
          <template #value>
            <span class="text-emerald-700">+{{ activity.diffStats.additions30d.toLocaleString() }}</span>
            <span class="ml-2 text-rose-700">−{{ activity.diffStats.deletions30d.toLocaleString() }}</span>
          </template>
          <template #hint>excludes merges</template>
        </StatCard>
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity — last 365 days</h2>
        <CommitHeatmap :data="activity.dailyCommits" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Contributors — last 30 days</h2>
        <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
          <ul v-if="activity.contributors.length > 0" class="divide-y divide-slate-100">
            <li v-for="(c, i) in activity.contributors" :key="c.bitbucketUuid">
              <RouterLink
                :to="{ name: 'user', params: { userId: c.userId } }"
                class="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <div class="flex items-center gap-3">
                  <span class="w-5 shrink-0 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
                  <span class="text-sm font-medium text-slate-900">{{ c.displayName }}</span>
                </div>
                <div class="flex items-center gap-3">
                  <!-- Sparkline scoped to this repo (last 30 days of commits
                       this user landed here). Same hover treatment as the
                       dashboard's top-contributors list — slate-400 →
                       blue-600 on row hover. -->
                  <Sparkline
                    :points="c.last30Days ?? []"
                    :width="128"
                    :height="16"
                    class="shrink-0 text-slate-400 transition-colors group-hover:text-blue-600"
                  />
                  <div v-if="activity.repository.diffStatsEnabled" class="flex items-center gap-1">
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
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity</h2>
        <ActivityFeed :repo="fullName" height="24rem" />
      </section>
    </template>
  </main>
</template>
