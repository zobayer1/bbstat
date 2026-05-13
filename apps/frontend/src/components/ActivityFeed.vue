<script setup lang="ts">
// Renders the unified commits + PRs timeline from /api/activity. Props
// scope the feed to a single actor / repo / project (omit all for the
// org-wide view). IntersectionObserver-driven infinite scroll: the
// sentinel below the list fires loadMore when it scrolls into view.
//
// The store keys its cache by the serialized filter triple, so mounting
// the same component with different props doesn't blow the cache —
// switching between repositories on a project page, for example, keeps
// the previous repo's pages around for instant return.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useActivityStore, type ActivityFilters } from '@/stores/activity';
import type { ActivityEntry } from '@/api/client';

const props = defineProps<{
  actor?: number;
  repo?: string;
  project?: string;
}>();

const store = useActivityStore();

const filters = computed<ActivityFilters>(() => {
  const f: ActivityFilters = {};
  if (props.actor !== undefined) f.actor = props.actor;
  if (props.repo !== undefined) f.repo = props.repo;
  if (props.project !== undefined) f.project = props.project;
  return f;
});

const filterKey = computed(() => store.keyFor(filters.value));
const entries = computed<ActivityEntry[]>(() => store.byKey[filterKey.value] ?? []);
const isLoading = computed(() => store.loading[filterKey.value] === true);
const errMsg = computed(() => store.error[filterKey.value] ?? null);
const isExhausted = computed(() => store.exhausted[filterKey.value] === true);

onMounted(() => void store.load(filters.value));
watch(filterKey, () => void store.load(filters.value));

// IntersectionObserver wiring. The sentinel below the list fires loadMore
// when it becomes visible — works for any height list inside any scroll
// container because `root: null` defaults to the viewport.
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  observer = new IntersectionObserver((obs) => {
    if (obs.some((e) => e.isIntersecting) && !isLoading.value && !isExhausted.value) {
      void store.loadMore(filters.value);
    }
  });
  if (sentinel.value !== null) observer.observe(sentinel.value);
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
});

function entryKey(e: ActivityEntry): string {
  if (e.kind === 'commit') return `c-${e.sha}`;
  // PR can resurface at multiple positions over its lifetime as updated_on
  // advances — include occurredAt so the Vue list key is unique per
  // appearance.
  return `p-${e.repository.fullName}-${e.prId}-${e.occurredAt}`;
}

function commitTitle(message: string): string {
  // Show only the first line — long commit messages would push the
  // timestamp off the row otherwise.
  return message.split('\n')[0] ?? '';
}

function prBadgeClass(state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'): string {
  switch (state) {
    case 'OPEN':
      return 'bg-blue-100 text-blue-700';
    case 'MERGED':
      return 'bg-violet-100 text-violet-700';
    case 'DECLINED':
      return 'bg-rose-100 text-rose-700';
    case 'SUPERSEDED':
      return 'bg-slate-100 text-slate-500';
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
    <p v-if="errMsg" class="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
      Could not load activity: {{ errMsg }}
    </p>

    <ul v-if="entries.length > 0" class="divide-y divide-slate-100">
      <li v-for="entry in entries" :key="entryKey(entry)" class="flex items-start gap-3 px-4 py-3 text-sm">
        <span
          v-if="entry.kind === 'commit'"
          class="mt-0.5 inline-block w-16 shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-emerald-700"
        >
          commit
        </span>
        <span
          v-else
          :class="prBadgeClass(entry.state)"
          class="mt-0.5 inline-block w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider"
        >
          {{ entry.state }}
        </span>

        <div class="min-w-0 flex-1">
          <p class="truncate text-slate-900">
            <RouterLink
              :to="{
                name: 'repository',
                params: { workspace: entry.repository.workspace, slug: entry.repository.slug },
              }"
              class="font-medium hover:text-slate-600"
            >
              {{ entry.repository.slug }}
            </RouterLink>
            <span v-if="entry.kind === 'commit'" class="text-slate-700"> — {{ commitTitle(entry.message) }}</span>
            <span v-else class="text-slate-700"> — #{{ entry.prId }} {{ entry.title }}</span>
          </p>
          <p class="mt-0.5 text-xs text-slate-500">
            <span v-if="entry.author">
              <RouterLink :to="{ name: 'user', params: { userId: entry.author.userId } }" class="hover:text-slate-700">
                {{ entry.author.displayName }}
              </RouterLink>
            </span>
            <span v-else class="italic">anonymous</span>
            ·
            <span>{{ formatTime(entry.occurredAt) }}</span>
            <span v-if="entry.kind === 'commit'"> · +{{ entry.additions }} −{{ entry.deletions }}</span>
            <span v-else> · {{ entry.sourceBranch }} → {{ entry.destinationBranch }}</span>
          </p>
        </div>
      </li>
    </ul>

    <p v-else-if="!isLoading && errMsg === null" class="px-4 py-6 text-center text-sm text-slate-400">
      No activity yet for this view.
    </p>

    <!-- Infinite-scroll sentinel + status row. Sentinel must exist in the DOM
         even when entries are empty so the first scroll into view can fire. -->
    <div ref="sentinel" class="h-px" />
    <p v-if="isLoading" class="px-4 py-2 text-center text-xs text-slate-400">Loading…</p>
    <p
      v-else-if="isExhausted && entries.length > 0"
      class="border-t border-slate-100 px-4 py-2 text-center text-xs text-slate-300"
    >
      No more activity.
    </p>
  </div>
</template>
