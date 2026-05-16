<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Fuse from 'fuse.js';
import { useMembersStore } from '@/stores/members';
import type { ContributorWindow, WorkspaceMember } from '@/api/client';

const store = useMembersStore();

onMounted(() => {
  void store.fetch();
});

const windows: ContributorWindow[] = ['7d', '30d'];
const windowLabel = (w: ContributorWindow) => (w === '7d' ? 'Last 7 days' : 'Last 30 days');

// Sortable columns. `key` is the WorkspaceMember field used for the
// comparator; `numeric` switches the comparator from locale-string to
// numeric. `lastActiveAt` sorts on the raw ISO string (lexical order
// is chronological for ISO-8601), with nulls pushed to the end so a
// never-active row doesn't outrank an active one in either direction.
type SortKey = 'commitsWindow' | 'commitsAllTime' | 'reposWindow' | 'lastActiveAt' | 'displayName';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('commitsWindow');
const sortDir = ref<SortDir>('desc');

function toggleSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    // Sensible default direction per column: counts → desc, names → asc.
    sortDir.value = key === 'displayName' ? 'asc' : 'desc';
  }
  // Sort/filter changes shouldn't strand the user on a now-empty page.
  page.value = 1;
}

const search = ref('');

// Fuse index. Rebuilds when the members payload changes (refetch /
// SSE refresh in a later commit). `keys` covers the two human-visible
// identifiers; `threshold: 0.4` is forgiving enough for typos but not
// so loose that unrelated names collide. `ignoreLocation` lets a match
// anywhere in the string count, so a search for "han" hits "Zobayer
// Hasan" without scoring proximity to position 0.
const fuse = computed(
  () =>
    new Fuse(store.members, {
      keys: ['displayName', 'username'],
      threshold: 0.4,
      ignoreLocation: true,
    }),
);

const filtered = computed<WorkspaceMember[]>(() => {
  const q = search.value.trim();
  if (q === '') return store.members;
  return fuse.value.search(q).map((r) => r.item);
});

const sorted = computed<WorkspaceMember[]>(() => {
  const list = filtered.value.slice();
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const key = sortKey.value;
  list.sort((a, b) => {
    if (key === 'displayName') {
      return a.displayName.localeCompare(b.displayName) * dir;
    }
    if (key === 'lastActiveAt') {
      // Nulls last regardless of direction — a never-active row at the top
      // of a desc sort would surprise the user. Treat null as "smaller
      // than anything" then flip the sentinel for asc.
      const av = a.lastActiveAt;
      const bv = b.lastActiveAt;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    }
    return (a[key] - b[key]) * dir;
  });
  return list;
});

const PAGE_SIZE = 100;
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)));
const pageClamped = computed(() => Math.min(page.value, pageCount.value));
const paged = computed<WorkspaceMember[]>(() => {
  const start = (pageClamped.value - 1) * PAGE_SIZE;
  return sorted.value.slice(start, start + PAGE_SIZE);
});

// Reset to page 1 whenever the search query changes — a search result
// of 12 rows shouldn't render an empty page 3.
watch(search, () => {
  page.value = 1;
});

// Compact "2h" / "3d" / "5w" relative time. Returns "—" for null
// (unreachable in steady state — the backend filter requires
// commitsAllTime > 0 — but we keep the guard for the empty-state
// render before the first fetch lands).
function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, (now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = diffSec / 60;
  if (diffMin < 60) return `${Math.round(diffMin)}m`;
  const diffHr = diffMin / 60;
  if (diffHr < 24) return `${Math.round(diffHr)}h`;
  const diffDay = diffHr / 24;
  if (diffDay < 14) return `${Math.round(diffDay)}d`;
  const diffWk = diffDay / 7;
  if (diffWk < 8) return `${Math.round(diffWk)}w`;
  const diffMo = diffDay / 30;
  if (diffMo < 12) return `${Math.round(diffMo)}mo`;
  return `${Math.round(diffDay / 365)}y`;
}

const sortIndicator = (key: SortKey): string => {
  if (sortKey.value !== key) return '';
  return sortDir.value === 'asc' ? ' ▲' : ' ▼';
};
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 text-3xl font-bold tracking-tight text-slate-900">Workspace Members</h1>
      <p class="mt-1 text-sm text-slate-500">Every contributor we've ingested at least one commit for.</p>
    </header>

    <section class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <input
          v-model="search"
          type="search"
          placeholder="Search by name or username…"
          class="w-64 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
          aria-label="Search workspace members"
        />
        <div
          class="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-200 text-xs"
          role="group"
          aria-label="Activity window"
        >
          <button
            v-for="w in windows"
            :key="w"
            type="button"
            class="px-3 py-2 transition"
            :class="store.window === w ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'"
            @click="void store.setWindow(w)"
          >
            {{ windowLabel(w) }}
          </button>
        </div>
      </div>
      <span class="text-xs text-slate-500">
        {{ sorted.length }} <span v-if="search.trim() !== ''">match{{ sorted.length === 1 ? '' : 'es' }}</span>
        <span v-else>member{{ sorted.length === 1 ? '' : 's' }}</span>
      </span>
    </section>

    <section class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table v-if="paged.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
        <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th class="px-4 py-2 text-left font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('displayName')">
                Member{{ sortIndicator('displayName') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('commitsWindow')">
                Commits{{ sortIndicator('commitsWindow') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('commitsAllTime')">
                All-time{{ sortIndicator('commitsAllTime') }}
              </button>
            </th>
            <!-- Same 3-column grid template as the cells below so the `/`
                 in the header lines up with the `/` in every row. -->
            <th class="px-4 py-2 font-medium">
              <div class="grid grid-cols-[1fr_auto_1fr] gap-1">
                <span class="text-right text-emerald-600">+</span>
                <span class="text-slate-300">/</span>
                <span class="text-left text-rose-600">−</span>
              </div>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('reposWindow')">
                Repos{{ sortIndicator('reposWindow') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('lastActiveAt')">
                Last active{{ sortIndicator('lastActiveAt') }}
              </button>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="m in paged" :key="m.bitbucketUuid" class="hover:bg-slate-50">
            <td class="px-4 py-2">
              <RouterLink
                :to="{ name: 'user', params: { userId: m.userId } }"
                class="block font-medium text-slate-900 hover:text-slate-600"
              >
                {{ m.displayName }}
                <span v-if="m.username" class="ml-1 text-xs font-normal text-slate-400">@{{ m.username }}</span>
              </RouterLink>
            </td>
            <td class="px-4 py-2 text-right text-slate-900">{{ m.commitsWindow }}</td>
            <td class="px-4 py-2 text-right text-slate-500">{{ m.commitsAllTime }}</td>
            <!-- 3-column grid with the `/` in a fixed center column so the
                 separator lines up vertically down the table — additions
                 right-justify into the gap, deletions left-justify out of
                 it. `tabular-nums` keeps digits the same width across
                 rows. -->
            <td class="px-4 py-2 text-xs tabular-nums">
              <div class="grid grid-cols-[1fr_auto_1fr] items-baseline gap-1">
                <span class="text-right text-emerald-600">+{{ m.additionsWindow }}</span>
                <span class="text-slate-300">/</span>
                <span class="text-left text-rose-600">−{{ m.deletionsWindow }}</span>
              </div>
            </td>
            <td class="px-4 py-2 text-right text-slate-900">{{ m.reposWindow }}</td>
            <td class="px-4 py-2 text-right text-slate-500" :title="m.lastActiveAt ?? ''">
              {{ relativeTime(m.lastActiveAt) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="store.loading && store.members.length === 0" class="px-4 py-6 text-center text-sm text-slate-400">
        Loading…
      </p>
      <p v-else-if="search.trim() !== ''" class="px-4 py-6 text-center text-sm text-slate-400">
        No members match “{{ search }}”.
      </p>
      <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No workspace members yet.</p>

      <div
        v-if="sorted.length > PAGE_SIZE"
        class="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500"
      >
        <span>
          Showing {{ (pageClamped - 1) * PAGE_SIZE + 1 }}–{{ Math.min(pageClamped * PAGE_SIZE, sorted.length) }} of
          {{ sorted.length }}
        </span>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="pageClamped <= 1"
            @click="page = 1"
          >
            First
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="pageClamped <= 1"
            @click="page = pageClamped - 1"
          >
            Prev
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="pageClamped >= pageCount"
            @click="page = pageClamped + 1"
          >
            Next
          </button>
          <button
            type="button"
            class="rounded px-2 py-1 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="pageClamped >= pageCount"
            @click="page = pageCount"
          >
            Last
          </button>
        </div>
      </div>
    </section>

    <p v-if="store.error" class="mt-4 text-sm text-red-600">Could not load members: {{ store.error }}</p>
  </main>
</template>
