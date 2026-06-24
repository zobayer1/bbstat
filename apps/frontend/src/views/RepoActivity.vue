<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import Breadcrumb from '@/components/Breadcrumb.vue';
import { GLYPHS } from '@/lib/glyphs';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import ActorPicker from '@/components/ActorPicker.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import Sparkline from '@/components/Sparkline.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { useRepoActivityStore } from '@/stores/repoActivity';
import { useActorFilter } from '@/composables/useActorFilter';

const route = useRoute();
const store = useRepoActivityStore();

const workspace = computed(() => String(route.params.workspace));
const slug = computed(() => String(route.params.slug));
const fullName = computed(() => `${workspace.value}/${slug.value}`);
const activity = computed(() => store.byFullName[fullName.value]);
const loading = computed(() => store.loading[fullName.value] === true);
const error = computed(() => store.error[fullName.value] ?? null);

const commits365d = computed(() => activity.value?.dailyCommits.reduce((acc, d) => acc + d.commits, 0) ?? 0);

onMounted(() => void store.fetch(workspace.value, slug.value));
watch([workspace, slug], () => void store.fetch(workspace.value, slug.value));

// Repo (and its project) is pinned by the route — only the contributor
// axis is filterable. A selected person filters across all their aliases.

// 30-day cutoff for the "See all activities →" link; matches the Activity
// page's preset detection so the "[Last 30 days]" chip lights up.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));
const filterActor = useActorFilter();
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <Breadcrumb
        :items="[
          { label: 'Repositories', to: '/repositories', icon: GLYPHS.folder },
          { label: slug, bracketed: true },
        ]"
      />
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900">
          <span>{{ slug }}</span>
          <SyncStateIcon
            v-if="activity"
            :status="activity.repository.syncStatus"
            :archived="activity.repository.archived"
          />
          <span
            v-if="activity?.repository.archived"
            class="rounded bg-slate-200 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-slate-500"
            title="Soft-retired — excluded from sync; status shown is its last known state."
            >Archived</span
          >
        </h1>
        <!-- BB repo link. -->
        <a
          :href="`https://bitbucket.org/${workspace}/${slug}`"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 text-xs text-slate-500 hover:text-blue-600"
          title="View on BitBucket"
        >
          View on BitBucket ↗
        </a>
      </div>
      <p v-if="activity" class="mt-1 text-sm text-slate-500">
        <template v-if="activity.repository.project">
          <RouterLink
            :to="{ name: 'project', params: { projectKey: activity.repository.project } }"
            class="font-medium text-slate-700 hover:text-slate-900"
          >
            {{ activity.repository.project }}
          </RouterLink>
          ·
        </template>
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
        </StatCard>
        <StatCard v-if="activity.diffStats" label="Code changes — last 30 days">
          <template #value>
            <span class="text-emerald-700">+{{ activity.diffStats.additions30d.toLocaleString() }}</span>
            <span class="ml-2 text-rose-700">−{{ activity.diffStats.deletions30d.toLocaleString() }}</span>
          </template>
        </StatCard>
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity — last 365 days</h2>
        <CommitHeatmap :data="activity.dailyCommits" scope="repo" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Contributors — last 30 days</h2>
        <div class="rounded-lg border border-slate-200 bg-white shadow-sm">
          <ul v-if="activity.contributors.length > 0" class="divide-y divide-slate-100">
            <li v-for="(c, i) in activity.contributors" :key="`${c.entityKind}:${c.entityId}`">
              <!-- Person rows → /people/:id, user rows → /users/:id. -->
              <RouterLink
                :to="
                  c.entityKind === 'person'
                    ? { name: 'person', params: { personId: c.entityId } }
                    : { name: 'user', params: { userId: c.entityId } }
                "
                class="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
              >
                <div class="flex min-w-0 items-center gap-3">
                  <span class="w-5 shrink-0 text-right text-sm font-mono text-slate-400">{{ i + 1 }}</span>
                  <span class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900">
                    <span class="truncate" :title="c.displayName">{{ c.displayName }}</span>
                    <span
                      v-if="c.entityKind === 'person' && c.attachedUserIds.length > 1"
                      class="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                      :title="`Merged from ${c.attachedUserIds.length} BitBucket accounts`"
                    >
                      ×{{ c.attachedUserIds.length }}
                    </span>
                  </span>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  <!-- Sparkline scoped to this repo (last 30 days). -->
                  <Sparkline
                    :points="c.last30Days ?? []"
                    :width="128"
                    :height="16"
                    class="shrink-0 text-slate-400 transition-colors group-hover:text-blue-600"
                  />
                  <div class="flex items-center gap-1">
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
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
          <!-- Repo pinned by route → only the user axis is filterable
               (a project filter would have one fixed option). -->
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <label for="repo-filter-user" class="flex items-center gap-1">
              <span class="text-slate-500">Contributor:</span>
              <ActorPicker id="repo-filter-user" v-model="filterActor" />
            </label>
          </div>
        </div>
        <ActivityFeed :repo="fullName" :actor="filterActor" height="24rem">
          <template #footer>
            <!-- Pre-applies this repo on /activity. -->
            <RouterLink
              :to="{ name: 'activity', query: { repo: fullName, after: activitySinceThirtyDays } }"
              class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              See all activities →
            </RouterLink>
          </template>
        </ActivityFeed>
      </section>
    </template>
  </main>
</template>
