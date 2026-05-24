<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import BadgeIcon from '@/components/BadgeIcon.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { usePersonSummaryStore } from '@/stores/personSummary';

const route = useRoute();
const store = usePersonSummaryStore();

const personId = computed(() => Number(route.params.personId));
const summary = computed(() => store.byPersonId[personId.value]);
const loading = computed(() => store.loading[personId.value] === true);
const error = computed(() => store.error[personId.value] ?? null);

onMounted(() => void store.fetch(personId.value));
watch(personId, (next) => void store.fetch(next));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/members" class="text-xs text-slate-500 hover:text-slate-700">← Members</RouterLink>
      <div class="mt-1 flex items-center gap-3">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">
          {{ summary?.person.displayName ?? `Person #${personId}` }}
        </h1>
        <!-- Merged-identity marker so the page reads unambiguously as a
             person (not a single BB account). -->
        <span
          v-if="summary"
          class="inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700"
          :title="`Merged from ${summary.attachedUsers.length} BitBucket account(s)`"
        >
          merged ×{{ summary.attachedUsers.length }}
        </span>
        <BadgeIcon
          v-if="summary && summary.person.badge"
          :badge="summary.person.badge"
          :tier="summary.person.badgeTier"
        />
      </div>
      <p v-if="summary?.person.email" class="mt-1 text-xs text-slate-400">{{ summary.person.email }}</p>
    </header>

    <p v-if="loading && !summary" class="text-sm text-slate-400">Loading…</p>
    <p v-if="error" class="mb-4 text-sm text-red-600">Could not load summary: {{ error }}</p>

    <template v-if="summary">
      <!-- Attached accounts — the underlying BB aliases this person was
           merged from. Each links to its per-alias /users/:id page,
           which keeps its own single-account history view. The primary
           alias (supplies the person's avatar / email defaults) is
           flagged. -->
      <section class="mb-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Attached accounts</h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="px-4 py-2 text-left font-medium">Account</th>
                <th class="px-4 py-2 text-left font-medium">Email</th>
                <th class="px-4 py-2 text-left font-medium">BitBucket UUID</th>
                <th class="px-4 py-2 text-center font-medium">Primary</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="a in summary.attachedUsers" :key="a.id" class="hover:bg-slate-50">
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
                <td class="px-4 py-2 text-center">
                  <span
                    v-if="a.isPrimary"
                    class="inline-block rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                    >primary</span
                  >
                  <span v-else class="text-slate-300">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

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
    </template>
  </main>
</template>
