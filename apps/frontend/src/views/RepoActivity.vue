<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import { useRepoActivityStore } from '@/stores/repoActivity';

const route = useRoute();
const store = useRepoActivityStore();

const workspace = computed(() => String(route.params.workspace));
const slug = computed(() => String(route.params.slug));
const fullName = computed(() => `${workspace.value}/${slug.value}`);
const activity = computed(() => store.byFullName[fullName.value]);
const loading = computed(() => store.loading[fullName.value] === true);
const error = computed(() => store.error[fullName.value] ?? null);

const commits30d = computed(() => activity.value?.dailyCommits.reduce((acc, d) => acc + d.commits, 0) ?? 0);

onMounted(() => void store.fetch(workspace.value, slug.value));
watch([workspace, slug], () => void store.fetch(workspace.value, slug.value));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 text-3xl font-bold tracking-tight text-slate-900">{{ slug }}</h1>
    </header>

    <p v-if="loading && !activity" class="text-sm text-slate-400">Loading…</p>
    <p v-if="error" class="mb-4 text-sm text-red-600">Could not load activity: {{ error }}</p>

    <template v-if="activity">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard label="Commits — last 30 days" :value="commits30d" />
        <StatCard label="Active contributors — 30d" :value="activity.contributors.length" />
      </section>

      <section class="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 class="mb-3 text-lg font-semibold text-slate-900">Last 30 days</h2>
          <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
            <ul v-if="activity.dailyCommits.length > 0" class="divide-y divide-slate-100">
              <li
                v-for="d in activity.dailyCommits"
                :key="d.date"
                class="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span class="font-mono text-slate-500">{{ d.date }}</span>
                <span class="text-slate-900">{{ d.commits }} commits</span>
              </li>
            </ul>
            <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No commits in the last 30 days.</p>
          </div>
        </div>

        <div>
          <h2 class="mb-3 text-lg font-semibold text-slate-900">Contributors — last 30 days</h2>
          <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
            <ul v-if="activity.contributors.length > 0" class="divide-y divide-slate-100">
              <li
                v-for="(c, i) in activity.contributors"
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
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity</h2>
        <ActivityFeed :repo="fullName" height="24rem" />
      </section>
    </template>
  </main>
</template>
