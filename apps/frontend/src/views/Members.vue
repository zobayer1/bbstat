<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Fuse from 'fuse.js';
import ActivityStatusDonut, { type ActivityBucket } from '@/components/ActivityStatusDonut.vue';
import LorenzCurve from '@/components/LorenzCurve.vue';
import Sparkline from '@/components/Sparkline.vue';
import { useMembersStore } from '@/stores/members';
import { useStatsStore } from '@/stores/stats';
import type { ContributorWindow, WorkspaceMember } from '@/api/client';

const store = useMembersStore();
const stats = useStatsStore();

onMounted(() => {
  void store.fetch();
  // Workspace total comes from the stats overview (counts every ingested
  // user row, including those with zero commits). The members API only
  // returns rows with commitsAllTime > 0, so we surface both numbers in
  // the subtitle to explain the gap (e.g., "36 of 49 …").
  void stats.fetchOverview();
});

const totalMembers = computed<number | null>(() => stats.overview?.users ?? null);
const activeMembers = computed<number>(() => store.members.length);
const inactiveMembers = computed<number | null>(() =>
  totalMembers.value === null ? null : Math.max(0, totalMembers.value - activeMembers.value),
);

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
      keys: ['displayName', 'username', 'email'],
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

// Activity-status donut: buckets every member by how recently they last
// committed, relative to now. Bucket boundaries are window-independent
// (the 7d/30d toggle drives the table, not this chart) — the donut is
// always answering "is the team alive *right now*?" across the same
// 7/30/90-day recency ramp.
//
// Buckets are mutually exclusive (Active-30d here means active within
// 30 days but NOT within 7) so the slices sum to total members and the
// donut reads as a partition, not nested rings.
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_COLORS = {
  active7d: '#10b981', // emerald-500
  active30d: '#3b82f6', // blue-500
  active90d: '#f59e0b', // amber-500
  dormant: '#94a3b8', // slate-400
};

const activityBuckets = computed<ActivityBucket[]>(() => {
  const now = Date.now();
  const counts = { a7: 0, a30: 0, a90: 0, dormant: 0 };
  for (const m of store.members) {
    if (m.lastActiveAt === null) {
      counts.dormant++;
      continue;
    }
    const ageDays = (now - new Date(m.lastActiveAt).getTime()) / DAY_MS;
    if (ageDays < 7) counts.a7++;
    else if (ageDays < 30) counts.a30++;
    else if (ageDays < 90) counts.a90++;
    else counts.dormant++;
  }
  return [
    { label: 'Active · 7d', count: counts.a7, color: ACTIVITY_COLORS.active7d },
    { label: 'Active · 30d', count: counts.a30, color: ACTIVITY_COLORS.active30d },
    { label: 'Active · 90d', count: counts.a90, color: ACTIVITY_COLORS.active90d },
    { label: 'Dormant', count: counts.dormant, color: ACTIVITY_COLORS.dormant },
  ];
});

// Lorenz curve values are window-scoped — the curve answers "how
// concentrated is contribution in the active window?" so it should
// retract/expand as the user toggles 7d ↔ 30d. The component itself
// filters zeros (a member who didn't commit in the window doesn't
// inform concentration; including them would flatten the left tail
// and visually understate the inequality).
const lorenzValues = computed(() => store.members.map((m) => m.commitsWindow));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <h1 class="mt-1 text-3xl font-bold tracking-tight text-slate-900">Workspace Members</h1>
      <!-- Active vs total spelt out so the page reconciles cleanly with
           the Dashboard's "Workspace Members" card, which counts every
           ingested user (including not-yet-active testers). Falls back
           to the bare description while the overview is in flight. -->
      <p v-if="totalMembers !== null" class="mt-1 text-sm text-slate-500">
        {{ activeMembers }} of {{ totalMembers }} workspace member<span v-if="totalMembers !== 1">s</span> with at least
        one ingested commit<span v-if="inactiveMembers && inactiveMembers > 0">
          · {{ inactiveMembers }} not yet active</span
        >.
      </p>
      <p v-else class="mt-1 text-sm text-slate-500">Every contributor we've ingested at least one commit for.</p>
    </header>

    <!-- Charts run above the filter row because they aggregate the entire
         roster — they don't respond to the search query, so placing them
         after the search input would mislead the user into thinking the
         filter applies here too.
         Captions live at the CARD level (not inside the chart components)
         so they sit flush at each card's bottom edge. Grid's default
         `items-stretch` equalizes card heights, which lines the two
         captions up horizontally regardless of how much vertical space
         the donut vs the Lorenz plot consume. -->
    <section class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="flex flex-col rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-xs font-medium uppercase tracking-wider text-slate-500">Activity status</h2>
        <div class="flex flex-1 items-center justify-center">
          <ActivityStatusDonut
            :buckets="activityBuckets"
            center-label="Members"
            :outer-radius="120"
            :inner-radius="76"
          />
        </div>
        <p class="mt-4 text-center text-[10px] text-slate-400">
          Members grouped by last-commit recency — green is most active, slate is dormant
        </p>
      </div>
      <div class="flex flex-col rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-xs font-medium uppercase tracking-wider text-slate-500">
          Commit concentration · {{ store.window }}
        </h2>
        <div class="flex flex-1 items-center">
          <LorenzCurve :values="lorenzValues" :width="480" :height="260" class="w-full" />
        </div>
        <p class="mt-4 text-center text-[10px] text-slate-400">
          Cumulative commits vs members — closer to the diagonal = flatter distribution
        </p>
      </div>
    </section>

    <section class="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <!-- Magnifying-glass affordance anchored inside the input.
             `relative` on the wrapper + `absolute` on the icon keeps
             the icon visually inside the field without participating
             in flex layout (so the field stays its declared width).
             Input gets left padding to make room for it. -->
        <div class="relative">
          <svg
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
            />
          </svg>
          <input
            id="members-search"
            v-model="search"
            type="search"
            name="members-search"
            autocomplete="off"
            placeholder="Search by name, username, or email…"
            class="w-80 rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400"
            aria-label="Search workspace members"
          />
        </div>
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
        <!-- Column layout:
               [ Member | Commits (win) | +/- (win) | Repos (win) ‖ Trend 30d | Last active | All-time ]
             The double-bar marks where the trailing window-independent
             columns begin — `Trend (30d)`, `Last active` and `All-time`
             aren't affected by the 7d/30d toggle, so they're grouped
             together at the far right with a visible left border on the
             first column of the group. Same border lives on the matching
             header cell and on every body cell to draw an unbroken
             vertical rule. -->
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
            <!-- Same 3-column grid template as the cells below so the `/`
                 in the header lines up with the `/` in every row. -->
            <th class="px-4 py-2 font-medium">
              <div class="grid grid-cols-[1fr_auto_1fr] gap-1">
                <span class="text-right text-emerald-600">+</span>
                <span class="text-slate-300">/</span>
                <span class="text-left text-rose-600">−</span>
              </div>
            </th>
            <th class="py-2 pr-6 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('reposWindow')">
                Repos{{ sortIndicator('reposWindow') }}
              </button>
            </th>
            <!-- Sparkline column carries the 2px left border that marks
                 the start of the window-independent column group. Header
                 is a plain label — no sort comparator makes sense for a
                 30-day shape — and the `(30d)` suffix calls out that this
                 column stays at 30 days regardless of the 7d/30d toggle. -->
            <th class="border-l-2 border-slate-200 px-4 py-2 text-right font-medium">
              Trend <span class="text-slate-400">(30d)</span>
            </th>
            <th class="py-2 pr-4 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('lastActiveAt')">
                Last active{{ sortIndicator('lastActiveAt') }}
              </button>
            </th>
            <th class="px-4 py-2 text-right font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('commitsAllTime')">
                All-time{{ sortIndicator('commitsAllTime') }}
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
              <!-- Git-author email: best-effort, parsed from commits.author.raw at
                   ingest. Rendered muted under the displayName so it never
                   competes with the primary identifier. Hidden entirely when
                   null (users predating the column or whose commits never
                   carried a parseable address). -->
              <div v-if="m.email" class="mt-0.5 truncate text-xs text-slate-400" :title="m.email">
                {{ m.email }}
              </div>
            </td>
            <td class="px-4 py-2 text-right text-slate-900">{{ m.commitsWindow }}</td>
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
            <td class="py-2 pr-6 text-right text-slate-900">{{ m.reposWindow }}</td>
            <td class="border-l-2 border-slate-200 px-4 py-2">
              <Sparkline :points="m.last30Days" :width="96" :height="18" class="ml-auto block text-slate-400" />
            </td>
            <td class="py-2 pr-4 text-right text-slate-500" :title="m.lastActiveAt ?? ''">
              {{ relativeTime(m.lastActiveAt) }}
            </td>
            <td class="px-4 py-2 text-right text-slate-500">{{ m.commitsAllTime }}</td>
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
