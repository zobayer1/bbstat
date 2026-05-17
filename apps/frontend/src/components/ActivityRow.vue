<script setup lang="ts">
// One row of the unified activity feed (a commit or a PR). Extracted from
// ActivityFeed.vue so the dedicated Activity page can render the same row
// shape without duplicating the badge / link / metadata markup.
//
// Owns: badge column (commit/merge or PR state), repository link, sha + title
// button (which emits `open-commit` so the parent can pop the detail modal),
// BitBucket external-link icon, author link, timestamp, additions/deletions/
// files, and the diff-stats-unavailable warning for commits whose /diffstat
// fetch was given up on by the orchestrator.

import { RouterLink } from 'vue-router';
import type { ActivityEntry } from '@/api/client';

defineProps<{ entry: ActivityEntry }>();
defineEmits<{ 'open-commit': [sha: string] }>();

function commitTitle(message: string): string {
  // First non-blank line, trimmed. A message that opens with a blank
  // line (body-only commit, no subject — common when authors hit Enter
  // before typing) would otherwise render as an empty button beside
  // the dash, so skip leading whitespace and take the first line with
  // actual content.
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '(no message)';
}

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
</script>

<template>
  <li class="flex items-start gap-3 px-4 py-3 text-sm">
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
      <!-- Single-line identifier row. The prefix (repo slug + sha or
           #PR + dashes) stays at its intrinsic size via `shrink-0`; the
           title element is the only flex child that can shrink and
           owns the truncation. That way a long body-only commit
           message still shows useful prefix text before the ellipsis
           instead of being entirely replaced by `…` when the parent
           paragraph runs out of room. -->
      <div class="flex min-w-0 items-baseline gap-1">
        <div class="flex shrink-0 items-baseline gap-1 text-slate-700">
          <RouterLink
            :to="{ name: 'repository', params: { workspace: entry.repository.workspace, slug: entry.repository.slug } }"
            class="font-medium text-slate-900 hover:text-slate-600"
          >
            {{ entry.repository.slug }}
          </RouterLink>
          <span class="text-slate-400">—</span>
          <span v-if="entry.kind === 'commit'" class="font-mono text-xs text-slate-500">
            {{ entry.sha.slice(0, 7) }}
          </span>
          <span v-else>#{{ entry.prId }}</span>
          <span class="text-slate-400">—</span>
        </div>
        <button
          v-if="entry.kind === 'commit'"
          type="button"
          class="min-w-0 flex-1 cursor-pointer truncate text-left font-medium text-slate-800 hover:underline"
          @click="$emit('open-commit', entry.sha)"
        >
          {{ commitTitle(entry.message) }}
        </button>
        <span v-else class="min-w-0 flex-1 truncate text-slate-800">{{ entry.title }}</span>
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
          <RouterLink :to="{ name: 'user', params: { userId: entry.author.userId } }" class="hover:text-slate-700">
            {{ entry.author.displayName }}
          </RouterLink>
        </span>
        <span v-else class="italic">anonymous</span>
        ·
        <span>{{ formatTime(entry.occurredAt) }}</span>
        <span v-if="entry.kind === 'commit' && entry.diffStatsUnavailable" class="inline-flex items-baseline">
          ·
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
</template>
