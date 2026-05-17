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
import { MAX_ENTRIES_PER_FILTER, useActivityStore, type ActivityFilters } from '@/stores/activity';
import type { ActivityCommit, ActivityEntry } from '@/api/client';
import ActivityRow from './ActivityRow.vue';
import CommitDetailModal from './CommitDetailModal.vue';

const props = defineProps<{
  actor?: number;
  repo?: string;
  project?: string;
  // Optional fixed CSS height (e.g., '24rem'). When set, the list scrolls
  // inside the component at exactly this height — the container does NOT
  // shrink to fit short content. Fixed (vs. max-height) so callers like
  // tabbed dashboards can swap panels without surrounding components
  // reflowing. The IntersectionObserver uses the scroll container as its
  // root so paging still fires as the sentinel scrolls into the inner
  // viewport. Omit (e.g., a future full-page activity view) for natural
  // page-flow height.
  height?: string;
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
// Front-end cap independent of server pagination: once the per-filter array
// hits MAX_ENTRIES_PER_FILTER the IntersectionObserver stops firing
// loadMore and the footer surfaces a "narrow your filter" hint instead of
// the "No more activity" message.
const isCapped = computed(() => entries.value.length >= MAX_ENTRIES_PER_FILTER);

onMounted(() => void store.load(filters.value));
watch(filterKey, () => void store.load(filters.value));

// IntersectionObserver wiring. The sentinel below the list fires loadMore
// when it becomes visible. When `height` is set the list scrolls inside
// `scrollContainer` — we hand that element to the observer's `root` so the
// sentinel becomes "intersecting" relative to the inner viewport, not the
// outer page. With no height `root: null` falls back to the page viewport.
const sentinel = ref<HTMLElement | null>(null);
const scrollContainer = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  observer = new IntersectionObserver(
    (obs) => {
      if (obs.some((e) => e.isIntersecting) && !isLoading.value && !isExhausted.value && !isCapped.value) {
        void store.loadMore(filters.value);
      }
    },
    props.height !== undefined && scrollContainer.value !== null ? { root: scrollContainer.value } : undefined,
  );
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

// Commit detail modal — clicking a commit's title / sha opens a centered
// dialog with the full message, stats, and prev/next navigation through
// commits in the currently-loaded feed. PR entries are deliberately
// out of scope; they have their own BB URL conventions and a different
// detail shape.
const commitEntries = computed<ActivityCommit[]>(() =>
  entries.value.filter((e): e is ActivityCommit => e.kind === 'commit'),
);
const selectedSha = ref<string | null>(null);
const selectedCommit = computed<ActivityCommit | null>(() => {
  if (selectedSha.value === null) return null;
  return commitEntries.value.find((c) => c.sha === selectedSha.value) ?? null;
});
const selectedIndex = computed<number>(() => {
  if (selectedSha.value === null) return -1;
  return commitEntries.value.findIndex((c) => c.sha === selectedSha.value);
});
const canPrev = computed(() => selectedIndex.value > 0);
const canNext = computed(() => selectedIndex.value >= 0 && selectedIndex.value < commitEntries.value.length - 1);

function openCommit(sha: string): void {
  selectedSha.value = sha;
}
function closeModal(): void {
  selectedSha.value = null;
}
function prevCommit(): void {
  if (!canPrev.value) return;
  const next = commitEntries.value[selectedIndex.value - 1];
  if (next !== undefined) selectedSha.value = next.sha;
}
function nextCommit(): void {
  if (!canNext.value) return;
  const next = commitEntries.value[selectedIndex.value + 1];
  if (next !== undefined) selectedSha.value = next.sha;
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
    <p v-if="errMsg" class="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-600">
      Could not load activity: {{ errMsg }}
    </p>

    <div ref="scrollContainer" :style="height !== undefined ? { height, overflowY: 'auto' } : {}">
      <ul v-if="entries.length > 0" class="divide-y divide-slate-100">
        <ActivityRow v-for="entry in entries" :key="entryKey(entry)" :entry="entry" @open-commit="openCommit" />
      </ul>

      <p v-else-if="!isLoading && errMsg === null" class="px-4 py-6 text-center text-sm text-slate-400">
        No activity yet for this view.
      </p>

      <!-- Infinite-scroll sentinel + status row. Sentinel must exist in the DOM
           even when entries are empty so the first scroll into view can fire. -->
      <div ref="sentinel" class="h-px" />
      <p v-if="isLoading" class="px-4 py-2 text-center text-xs text-slate-400">Loading…</p>
      <p v-else-if="isCapped" class="border-t border-slate-100 px-4 py-2 text-center text-xs text-slate-500">
        Showing newest {{ MAX_ENTRIES_PER_FILTER }} entries — apply a filter to see older activity.
      </p>
      <p
        v-else-if="isExhausted && entries.length > 0"
        class="border-t border-slate-100 px-4 py-2 text-center text-xs text-slate-300"
      >
        No more activity.
      </p>
    </div>

    <!-- Optional footer slot — used by the Dashboard to drop a "More →"
         link below the scrolling region. Other callers (User / Repo /
         Project pages) don't provide a footer; the slot is silently
         empty in that case. Sits outside `scrollContainer` so it stays
         visible while the list scrolls underneath. -->
    <slot name="footer" />

    <CommitDetailModal
      v-if="selectedCommit !== null"
      :commit="selectedCommit"
      :can-prev="canPrev"
      :can-next="canNext"
      @close="closeModal"
      @prev="prevCommit"
      @next="nextCommit"
    />
  </div>
</template>
