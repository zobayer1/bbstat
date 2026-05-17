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
import { MAX_ENTRIES_PER_FILTER, useActivityStore, type ActivityFilters } from '@/stores/activity';
import type { ActivityCommit, ActivityEntry } from '@/api/client';
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

function commitTitle(message: string): string {
  // Show only the first line — long commit messages would push the
  // timestamp off the row otherwise.
  return message.split('\n')[0] ?? '';
}

// Web URL on bitbucket.org (NOT the API host) for the row's canonical
// upstream view. Used by the small external-link icon at the right edge
// of each title line. Hardcoded to the Cloud host since this project
// targets BitBucket Cloud per CLAUDE.md; self-hosted Server would need a
// config-driven base URL.
function bitbucketUrl(entry: ActivityEntry): string {
  const { workspace, slug } = entry.repository;
  if (entry.kind === 'commit') return `https://bitbucket.org/${workspace}/${slug}/commits/${entry.sha}`;
  return `https://bitbucket.org/${workspace}/${slug}/pull-requests/${entry.prId}`;
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
        <li v-for="entry in entries" :key="entryKey(entry)" class="flex items-start gap-3 px-4 py-3 text-sm">
          <div v-if="entry.kind === 'commit'" class="mt-0.5 flex w-16 shrink-0 flex-col items-stretch gap-1">
            <span
              class="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-emerald-700"
            >
              commit
            </span>
            <span
              v-if="entry.isMerge"
              class="inline-block rounded bg-violet-100 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-violet-700"
              title="Merge commit — additions / deletions cover the merged branch's full delta, not authorship volume"
            >
              merge
            </span>
          </div>
          <span
            v-else
            :class="prBadgeClass(entry.state)"
            class="mt-0.5 inline-block w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider"
          >
            {{ entry.state }}
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <p class="min-w-0 flex-1 truncate text-slate-900">
                <RouterLink
                  :to="{
                    name: 'repository',
                    params: { workspace: entry.repository.workspace, slug: entry.repository.slug },
                  }"
                  class="font-medium hover:text-slate-600"
                >
                  {{ entry.repository.slug }}
                </RouterLink>
                <span v-if="entry.kind === 'commit'" class="text-slate-700">
                  —
                  <!-- Sha + visual separator are static labels — the modal
                       trigger lives ONLY on the title, so the hover-underline
                       doesn't sweep across the monospaced sha and the
                       slate-400 dash (which read awkwardly underlined). -->
                  <span class="font-mono text-xs text-slate-500">{{ entry.sha.slice(0, 7) }}</span>
                  <span class="mx-1.5 text-slate-400">—</span>
                  <button
                    type="button"
                    class="cursor-pointer text-left font-medium text-slate-800 hover:underline"
                    @click="openCommit(entry.sha)"
                  >
                    {{ commitTitle(entry.message) }}
                  </button>
                </span>
                <span v-else class="text-slate-700"> — #{{ entry.prId }} {{ entry.title }}</span>
              </p>
              <!-- Open the canonical view on bitbucket.org in a new tab.
                   Deliberately separate from the commit/PR title link so
                   clicking the title still opens our local detail modal /
                   page rather than navigating away. `rel=noopener` is
                   standard for target=_blank links. -->
              <a
                :href="bitbucketUrl(entry)"
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 text-slate-400 transition-colors hover:text-blue-600"
                :title="entry.kind === 'commit' ? 'Open commit on BitBucket' : 'Open pull request on BitBucket'"
                :aria-label="entry.kind === 'commit' ? 'Open commit on BitBucket' : 'Open pull request on BitBucket'"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-4"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
              </a>
            </div>
            <p class="mt-1.5 text-xs text-slate-500">
              <span v-if="entry.author">
                <RouterLink
                  :to="{ name: 'user', params: { userId: entry.author.userId } }"
                  class="hover:text-slate-700"
                >
                  {{ entry.author.displayName }}
                </RouterLink>
              </span>
              <span v-else class="italic">anonymous</span>
              ·
              <span>{{ formatTime(entry.occurredAt) }}</span>
              <span v-if="entry.kind === 'commit' && entry.diffStatsUnavailable" class="inline-flex items-baseline">
                ·
                <!-- BB returned HTTP 555 (compute timeout) on /diffstat for
                     this commit too many times; the orchestrator gave up
                     and stamped it with zeros. Render an amber warning
                     icon in place of the +/-/files line so the row reads
                     as "stats unavailable" instead of misleadingly "no
                     changes". Tooltip surfaces the underlying cause. -->
                <span
                  class="ml-1 inline-flex cursor-help items-baseline text-amber-600 hover:text-amber-700"
                  title="BitBucket compute timeout (HTTP 555) — diff stats unavailable for this commit"
                  aria-label="Diff stats unavailable: BitBucket compute timeout"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-3.5 self-center"
                    aria-hidden="true"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                    />
                  </svg>
                  <span class="ml-1">stats unavailable</span>
                </span>
              </span>
              <span v-else-if="entry.kind === 'commit'">
                · +{{ entry.additions }} −{{ entry.deletions }}
                <span v-if="entry.filesChanged > 0">
                  · {{ entry.filesChanged }} file<span v-if="entry.filesChanged !== 1">s</span>
                </span>
              </span>
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
