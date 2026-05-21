<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import Fuse from 'fuse.js';
import ActiveMembersBar, { type ActivityBucket } from '@/components/ActiveMembersBar.vue';
import BadgeIcon from '@/components/BadgeIcon.vue';
import LorenzCurve from '@/components/LorenzCurve.vue';
import Sparkline from '@/components/Sparkline.vue';
import { useMembersStore } from '@/stores/members';
import { useStatsStore } from '@/stores/stats';
import type { WorkspaceMember } from '@/api/client';

const store = useMembersStore();
const stats = useStatsStore();

// Workspace for the "View on BitBucket" header link. Derived from
// the first tracked repo — single-workspace deployment by design,
// so any row's workspace is canonical. Empty until stats land,
// which hides the link via v-if.
const workspace = computed(() => stats.repositories[0]?.workspace ?? '');

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

// Membership-status partition of the full ingested roster. Counts the
// whole payload (NOT filtered by activity window) since these counts
// describe roster shape, not recent activity. Sums to
// store.members.length.
//
// `otherContributorCount` covers everyone whose BB UUID isn't in the
// workspace's `/members` endpoint at sync time. That bucket is more
// heterogeneous than "removed" suggests:
//   - ex-employees who left the workspace,
//   - external contributors who never joined,
//   - current workspace members who happen to commit from a different
//     BB account (i.e. their git email maps to a separate UUID that
//     hasn't been added to the workspace).
// "Other Contributors" is the umbrella label that doesn't overclaim
// about any of those subgroups.
const workspaceMemberCount = computed<number>(() => store.members.filter((m) => m.isWorkspaceMember).length);
const otherContributorCount = computed<number>(() => store.members.filter((m) => !m.isWorkspaceMember).length);

// Day constant — used by the activity-buckets chart at the bottom of
// the file. The table itself no longer filters by recency window; it's
// a straight paginated roster with 7d + 30d columns side-by-side.
const DAY_MS = 24 * 60 * 60 * 1000;

// Sortable columns. `key` is the WorkspaceMember field used for the
// comparator. `lastActiveAt` sorts on the raw ISO string (lexical order
// is chronological for ISO-8601), with nulls pushed to the end so a
// never-active row doesn't outrank an active one in either direction.
// `scoreTrending` and `consistency90d` similarly push nulls last —
// rows whose user_score hasn't landed yet (between member sync and the
// next commits-sync tick) shouldn't ride at the top.
//
// Default sort: `scoreTrending` desc — the leaderboard view of this
// page (docs/scoring.md). Dormant rows (scoreTrending = 0) sink to
// the bottom naturally.
type SortKey =
  | 'commits7d'
  | 'commits30d'
  | 'commitsAllTime'
  | 'lastActiveAt'
  | 'displayName'
  | 'scoreTrending'
  | 'consistency90d';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('scoreTrending');
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

// Fuzzy search runs straight over the full roster — no recency-window
// filter anymore. `threshold: 0.4` is forgiving enough for typos but
// not so loose that unrelated names collide; `ignoreLocation` lets a
// match anywhere in the string count (so a search for "han" hits
// "Zobayer Hasan" without scoring proximity to position 0).
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
    if (key === 'scoreTrending' || key === 'consistency90d') {
      // Nulls last regardless of direction — same rationale as
      // lastActiveAt; a row with no user_score yet shouldn't outrank
      // someone with a real number in either direction.
      const av = a[key];
      const bv = b[key];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    }
    return (a[key] - b[key]) * dir;
  });
  return list;
});

const PAGE_SIZE = 50;
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)));
const pageClamped = computed(() => Math.min(page.value, pageCount.value));
const paged = computed<WorkspaceMember[]>(() => {
  const start = (pageClamped.value - 1) * PAGE_SIZE;
  return sorted.value.slice(start, start + PAGE_SIZE);
});

// Reset to page 1 whenever the search query changes — a search
// result of 12 rows shouldn't render an empty page 3.
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

// Score column formatters. Momentum is a raw sum of log-capped per-
// commit scores so the absolute value is opaque — round to one decimal.
// Consistency is a 0–1 ratio displayed as a percentage. Both render "—"
// for null (user_score row not yet written, or cold-start consistency).
function formatMomentum(v: number | null): string {
  if (v === null) return '—';
  return v.toFixed(1);
}

function formatConsistency(v: number | null): string {
  if (v === null) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

// Active-members chart buckets: members counted across CUMULATIVE
// recency ranges, restricted to the trailing year. Each bucket
// counts every member active within its range — so by construction
// count(7d) ≤ count(30d) ≤ count(1y); a 5-day-old commit lands in
// all three, a 100-day-old commit lands in only 1y. The
// ActiveMembersBar component renders each bucket as its own row
// (no stacking, no partition) — the honest geometry for nested
// ranges, since a stacked bar would double-count overlapping
// members.
//
// Three shades of emerald — saturated → faded — read as a single
// "activity, fading with time" axis: emerald-700 (7d, darkest
// and shortest bar) for tightest recency; emerald-300 (1y, palest
// and longest bar) for the widest range.
//
// Dormant (no commit in 365d, or never-active) is intentionally
// excluded — after the anonymous-sweep added ex-employees, Dormant
// dwarfs every other bucket and drowns out the comparison that
// matters. The title "Active Members (1 year)" makes the inclusion
// criterion explicit.
const ACTIVITY_COLORS = {
  active7d: '#047857', // emerald-700
  active30d: '#10b981', // emerald-500
  active1y: '#6ee7b7', // emerald-300
};

const activityBuckets = computed<ActivityBucket[]>(() => {
  const now = Date.now();
  const counts = { a7: 0, a30: 0, a1y: 0 };
  for (const m of store.members) {
    if (m.lastActiveAt === null) continue;
    const ageDays = (now - new Date(m.lastActiveAt).getTime()) / DAY_MS;
    // Cumulative — a member active in the last 7 days also counts
    // toward the 30d and 1y buckets. No `else if` chain.
    if (ageDays < 365) counts.a1y++;
    if (ageDays < 30) counts.a30++;
    if (ageDays < 7) counts.a7++;
  }
  return [
    { label: 'Active · 7d', count: counts.a7, color: ACTIVITY_COLORS.active7d },
    { label: 'Active · 30d', count: counts.a30, color: ACTIVITY_COLORS.active30d },
    { label: 'Active · 1y', count: counts.a1y, color: ACTIVITY_COLORS.active1y },
  ];
});

// Lorenz curve values: 30-day commit counts. The table dropped its
// window-toggle UI, so the curve also stops responding to one —
// fixed at 30d here, the same window the Trend sparkline column uses.
// The component itself filters zeros (a member who didn't commit in
// the window doesn't inform concentration; including them would flatten
// the left tail and visually understate the inequality).
const lorenzValues = computed(() => store.members.map((m) => m.commits30d));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/" class="text-xs text-slate-500 hover:text-slate-700">← Dashboard</RouterLink>
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">Workspace Members</h1>
        <!-- Thin external link to BB's workspace members directory.
             Hidden until stats land so the URL is never built from an
             empty workspace string. -->
        <a
          v-if="workspace"
          :href="`https://bitbucket.org/${workspace}/workspace/members/`"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 text-xs text-slate-500 hover:text-blue-600"
          title="View on BitBucket"
        >
          View on BitBucket ↗
        </a>
      </div>
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
        <h2 class="mb-4 text-center text-xs font-medium uppercase tracking-wider text-slate-500">
          Tracked Members
          <span class="text-slate-400">({{ store.members.length }})</span>
        </h2>
        <!-- Membership-status partition of the full ingested roster,
             above the bar so it frames the activity breakdown that
             follows. Workspace Members is the current /members
             roster; Other Contributors is everyone else (ex-employees,
             externals, AND current members whose git email maps to a
             BB account not in the workspace member list). The latter
             is rendered muted to match the table-row treatment below. -->
        <div class="mb-4 grid grid-cols-2 divide-x divide-slate-200 text-center">
          <div>
            <p class="text-2xl font-semibold tabular-nums text-slate-900">{{ workspaceMemberCount }}</p>
            <p class="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">Workspace Members</p>
          </div>
          <div>
            <p class="text-2xl font-semibold tabular-nums text-slate-400">{{ otherContributorCount }}</p>
            <p class="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">Other Contributors</p>
          </div>
        </div>
        <div class="flex flex-1 items-center justify-center">
          <!-- Three nested-range bars (7d, 30d, 1y), each sized to
               its own cumulative count. See activityBuckets above
               for the semantic; ActiveMembersBar.vue for the layout. -->
          <ActiveMembersBar :buckets="activityBuckets" :bar-height="32" :bar-gap="14" class="w-full max-w-[480px]" />
        </div>
        <p class="mt-4 text-center text-[10px] text-slate-400">
          Members active in the last 7 / 30 / 365 days. Ranges are cumulative — 30d includes 7d, 1y includes 30d.
        </p>
      </div>
      <div class="flex flex-col rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-center text-xs font-medium uppercase tracking-wider text-slate-500">
          Commit concentration · 30d
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
      </div>
      <span class="text-xs text-slate-500">
        {{ sorted.length }} <span v-if="search.trim() !== ''">match{{ sorted.length === 1 ? '' : 'es' }}</span>
        <span v-else>member{{ sorted.length === 1 ? '' : 's' }}</span>
      </span>
    </section>

    <section class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table v-if="paged.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
        <!-- Column layout (leaderboard mode — docs/scoring.md):
               [ Badge icon | Member | Trend 30d | Momentum ↓ | Consistency · 90d | Last active | Commits · 7d | Commits · 30d | All-time ]
             Momentum is the default sort — the decayed per-commit score
             sum referred to as `scoreTrending` in code / docs (the
             user-facing label was renamed from "Trending" because the
             column sits next to "Trend (30d)" and people read "trending"
             as a boolean flag, not a number). Consistency is a sibling
             rank — sortable independently per the design discussion
             ("don't blend the two"). The 30d sparkline sits at column 3
             (right after Member) so the eye gets a "shape of activity"
             preview before the numeric scores. The legacy commit-count
             columns trail so the page still answers "how much did they
             ship" alongside the score view. Badge column is leftmost
             as a colored icon (no text label, tooltip-only) — matches
             the SyncStateIcon column convention in ProjectStats. -->
        <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th class="w-8 px-2 py-2 text-center font-medium">
              <span class="sr-only">Persona badge</span>
            </th>
            <th class="px-4 py-2 text-left font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('displayName')">
                Member{{ sortIndicator('displayName') }}
              </button>
            </th>
            <th class="px-4 py-2 text-center font-medium">Trend <span class="text-slate-400">(30d)</span></th>
            <th class="px-4 py-2 text-center font-medium">
              <button
                type="button"
                class="hover:text-slate-700"
                title="Decayed per-commit score sum (30-day half-life). Default sort."
                @click="toggleSort('scoreTrending')"
              >
                Momentum{{ sortIndicator('scoreTrending') }}
              </button>
            </th>
            <th class="px-4 py-2 text-center font-medium">
              <button
                type="button"
                class="hover:text-slate-700"
                title="Regularity of commit spacing over the last 90 days."
                @click="toggleSort('consistency90d')"
              >
                Consistency <span class="text-slate-400">(90d)</span>{{ sortIndicator('consistency90d') }}
              </button>
            </th>
            <th class="px-4 py-2 text-center font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('lastActiveAt')">
                Last active{{ sortIndicator('lastActiveAt') }}
              </button>
            </th>
            <th class="px-4 py-2 text-center font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('commits7d')">
                Commits · 7d{{ sortIndicator('commits7d') }}
              </button>
            </th>
            <th class="px-4 py-2 text-center font-medium">
              <button type="button" class="hover:text-slate-700" @click="toggleSort('commits30d')">
                Commits · 30d{{ sortIndicator('commits30d') }}
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
          <!-- Other Contributors — rows whose BB UUID isn't in the
               workspace's /members endpoint. Covers ex-employees,
               externals, AND current members who commit from a
               separate BB account (their git email maps to a UUID
               that's not in the member list). Rendered at reduced
               opacity so sort order still works but the eye knows
               these aren't fully-linked workspace identities.
               `bg-slate-50/60` adds a faint wash to distinguish them
               from in-workspace rows even before hover; the existing
               `hover:bg-slate-50` still applies for consistency. -->
          <tr
            v-for="m in paged"
            :key="m.bitbucketUuid"
            :class="[
              'hover:bg-slate-50',
              !m.isWorkspaceMember ? 'bg-slate-50/60 text-slate-400 opacity-70' : '',
              m.isDormant ? 'text-slate-400 opacity-60' : '',
            ]"
            :title="
              m.isDormant
                ? 'Dormant — no eligible activity in the last 90 days'
                : m.isWorkspaceMember
                  ? ''
                  : 'BB account not in the workspace member list (ex-employee, external, or current member using a separate email)'
            "
          >
            <td class="px-2 py-2 text-center align-middle">
              <BadgeIcon :badge="m.badge" :tier="m.badgeTier" />
            </td>
            <td class="px-4 py-2">
              <RouterLink
                :to="{ name: 'user', params: { userId: m.userId } }"
                :class="[
                  'block font-medium hover:text-slate-600',
                  m.isWorkspaceMember && !m.isDormant ? 'text-slate-900' : 'text-slate-500',
                ]"
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
            <td class="px-4 py-2">
              <Sparkline :points="m.last30Days" :width="96" :height="18" class="mx-auto block text-slate-400" />
            </td>
            <td class="px-4 py-2 text-center tabular-nums" :class="m.isDormant ? 'text-slate-400' : 'text-slate-900'">
              {{ formatMomentum(m.scoreTrending) }}
            </td>
            <td class="px-4 py-2 text-center tabular-nums" :class="m.isDormant ? 'text-slate-400' : 'text-slate-700'">
              {{ formatConsistency(m.consistency90d) }}
            </td>
            <td class="px-4 py-2 text-center text-slate-500" :title="m.lastActiveAt ?? ''">
              {{ relativeTime(m.lastActiveAt) }}
            </td>
            <!-- Per-window cells: primary commit count followed by the
                 distinct-repo count in parens at half scale + slate-400
                 so the breadth metric reads as supplementary context,
                 not a competing number. `tabular-nums` keeps the
                 digits column-aligned cleanly across rows. -->
            <td
              :class="['px-4 py-2 text-center tabular-nums', m.isWorkspaceMember ? 'text-slate-900' : 'text-slate-500']"
            >
              {{ m.commits7d }}
              <span class="ml-1 text-xs font-normal text-slate-400">({{ m.repos7d }})</span>
            </td>
            <td
              :class="['px-4 py-2 text-center tabular-nums', m.isWorkspaceMember ? 'text-slate-900' : 'text-slate-500']"
            >
              {{ m.commits30d }}
              <span class="ml-1 text-xs font-normal text-slate-400">({{ m.repos30d }})</span>
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
