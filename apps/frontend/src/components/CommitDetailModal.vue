<script setup lang="ts">
// Modal opened from the activity feed when an operator clicks a commit's
// title / sha. Shows the full commit message (the feed truncates to the
// subject line), author, stats, and an external link to the
// BitBucket commit page. Prev/next buttons walk through commits within
// the currently-loaded feed entries; PR entries are skipped by the
// parent so this modal only sees commits.
//
// Keyboard:
//   Esc        — close
//   Left/←     — previous (when enabled)
//   Right/→    — next (when enabled)
//
// Closes on overlay click and on the explicit X button.

import { computed, onMounted, onUnmounted } from 'vue';
import { RouterLink } from 'vue-router';
import type { ActivityCommit } from '@/api/client';

const props = defineProps<{
  commit: ActivityCommit;
  canPrev: boolean;
  canNext: boolean;
}>();

const emit = defineEmits<{
  close: [];
  prev: [];
  next: [];
}>();

const bitbucketUrl = computed(
  () =>
    `https://bitbucket.org/${props.commit.repository.workspace}/${props.commit.repository.slug}/commits/${props.commit.sha}`,
);

const formattedTime = computed(() => new Date(props.commit.occurredAt).toLocaleString());

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key === 'ArrowLeft' && props.canPrev) {
    event.preventDefault();
    emit('prev');
    return;
  }
  if (event.key === 'ArrowRight' && props.canNext) {
    event.preventDefault();
    emit('next');
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="commit-modal-title"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-2xl overflow-hidden rounded-lg bg-white shadow-2xl">
      <header class="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div class="flex min-w-0 items-baseline gap-3">
          <h2 id="commit-modal-title" class="font-mono text-sm font-semibold text-slate-900">
            {{ commit.sha.slice(0, 12) }}
          </h2>
          <RouterLink
            :to="{
              name: 'repository',
              params: { workspace: commit.repository.workspace, slug: commit.repository.slug },
            }"
            class="truncate text-xs text-slate-500 hover:text-slate-700"
          >
            {{ commit.repository.fullName }}
          </RouterLink>
        </div>
        <button
          type="button"
          class="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Close"
          @click="emit('close')"
        >
          <svg
            viewBox="0 0 16 16"
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </header>

      <div class="space-y-4 px-5 py-4">
        <pre class="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-sm text-slate-800">{{
          commit.message
        }}</pre>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span v-if="commit.author">
            <RouterLink :to="{ name: 'user', params: { userId: commit.author.userId } }" class="hover:text-slate-700">
              {{ commit.author.displayName }}
            </RouterLink>
          </span>
          <span v-else class="italic">anonymous</span>
          <span>{{ formattedTime }}</span>
          <!-- Diff stats unavailable: BB returned HTTP 555 (compute timeout)
               too many times for this commit's /diffstat. Show an amber
               warning glyph + tooltip rather than misleading "0 / 0 / 0
               files" — the numbers are nominally accurate but read as "no
               change" which is wrong for what's usually a very heavy
               commit. -->
          <span
            v-if="commit.diffStatsUnavailable"
            class="inline-flex cursor-help items-center gap-1 text-amber-600 hover:text-amber-700"
            title="BitBucket compute timeout (HTTP 555) — diff stats unavailable for this commit"
            aria-label="Diff stats unavailable: BitBucket compute timeout"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
              />
            </svg>
            <span>stats unavailable</span>
          </span>
          <span v-else>
            <span class="text-emerald-700">+{{ commit.additions.toLocaleString() }}</span>
            <span class="ml-2 text-rose-700">−{{ commit.deletions.toLocaleString() }}</span>
            <span v-if="commit.filesChanged > 0" class="ml-2"
              >· {{ commit.filesChanged }} file<span v-if="commit.filesChanged !== 1">s</span></span
            >
          </span>
          <span
            v-if="commit.isMerge"
            class="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-700"
            title="Merge commit — additions/deletions cover the merged branch's full delta"
          >
            merge
          </span>
        </div>

        <a
          :href="bitbucketUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-xs text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
        >
          View on Bitbucket
          <svg
            viewBox="0 0 16 16"
            class="h-3 w-3"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M5 3h8v8M13 3L5 11" />
          </svg>
        </a>
      </div>

      <footer class="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs">
        <span class="text-slate-400">←/→ navigate · Esc close</span>
        <div class="flex gap-2">
          <button
            type="button"
            :disabled="!canPrev"
            class="rounded border border-slate-200 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
            @click="emit('prev')"
          >
            ← Previous
          </button>
          <button
            type="button"
            :disabled="!canNext"
            class="rounded border border-slate-200 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white"
            @click="emit('next')"
          >
            Next →
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
