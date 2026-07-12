<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import Fuse from 'fuse.js';
import ActiveMembersBar, { type ActivityBucket } from '@/components/ActiveMembersBar.vue';
import Breadcrumb from '@/components/Breadcrumb.vue';
import { GLYPHS } from '@/lib/glyphs';
import ActivityFeed from '@/components/ActivityFeed.vue';
import ActorPicker from '@/components/ActorPicker.vue';
import BadgeIcon from '@/components/BadgeIcon.vue';
import LorenzCurve from '@/components/LorenzCurve.vue';
import MethodologyModal from '@/components/MethodologyModal.vue';
import Sparkline from '@/components/Sparkline.vue';
import { useMembersStore } from '@/stores/members';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import { useActorFilter } from '@/composables/useActorFilter';
import type { WorkspaceMember } from '@/api/client';

const store = useMembersStore();
const stats = useStatsStore();
const route = useRoute();
const router = useRouter();

// Workspace for the "View on BitBucket" header link. Single-workspace
// deployment, so any row's workspace is canonical; empty until stats land.
const workspace = computed(() => stats.repositories[0]?.workspace ?? '');

onMounted(() => {
  void store.fetch();
  // Overview counts every ingested user (incl. zero-commit); the members
  // API only returns commitsAllTime > 0. Both numbers feed the subtitle
  // (e.g. "36 of 49 …") to explain the gap.
  void stats.fetchOverview();
});

const totalMembers = computed<number | null>(() => stats.overview?.contributors ?? null);
const activeMembers = computed<number>(() => store.members.length);
const inactiveMembers = computed<number | null>(() =>
  totalMembers.value === null ? null : Math.max(0, totalMembers.value - activeMembers.value),
);

// Activity-feed filters. The page's own search / sort are local refs, so
// these can use the default `?project` / `?repo` / `?actor` keys without collision.
const filterActor = useActorFilter();
const {
  projectModel: filterProject,
  repoModel: filterRepo,
  projectOptions: activityProjectOptions,
  repoOptions: activityRepoOptions,
} = useActivityFilters({ repositories: computed(() => stats.repositories) });
const activityFiltersActive = computed(
  () => filterActor.value !== undefined || filterProject.value !== undefined || filterRepo.value !== undefined,
);
function clearActivityFilters(): void {
  const next = { ...route.query };
  delete next.project;
  delete next.repo;
  delete next.actor;
  delete next.actorKind;
  void router.replace({ query: next });
}
// 30-day cutoff for the "See all activities →" footer.
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));

// Membership provenance is computed server-side (single source of truth shared
// with the leaderboard filter — see WorkspaceMember.membershipStatus in the
// backend). The frontend just reads it: 'member' (flagged, overridden, merged
// person, or org-email), 'departed' (was in the roster, since gone), or
// 'external' (outside contributor). An operator forces any status via
// POST /admin/users/:id/override.
type MemberStatus = WorkspaceMember['membershipStatus'];
function memberStatus(m: WorkspaceMember): MemberStatus {
  return m.membershipStatus;
}

// Muting reflects MEMBERSHIP only — a member always renders full-strength, even
// when dormant, so an active-but-quiet member (e.g. a merged person whose last
// commit predates the 90d window) never looks like a non-member. Only departed
// and external rows are muted; dormancy still shows via "Last active" + a low
// momentum/consistency.
function isMuted(m: WorkspaceMember): boolean {
  return m.membershipStatus !== 'member';
}

const workspaceMemberCount = computed<number>(
  () => store.members.filter((m) => m.membershipStatus === 'member').length,
);
const departedCount = computed<number>(() => store.members.filter((m) => m.membershipStatus === 'departed').length);
const externalCount = computed<number>(() => store.members.filter((m) => m.membershipStatus === 'external').length);

const DAY_MS = 24 * 60 * 60 * 1000;

// Sortable columns. `lastActiveAt` sorts on the raw ISO string (lexical =
// chronological), with nulls last so a never-active row doesn't outrank an
// active one; `scoreTrending` / `consistency90d` push nulls last for the
// same reason (user_score may not have landed yet). Default sort:
// `scoreTrending` desc — the leaderboard view (docs/scoring.md).
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
    // Default direction: counts → desc, names → asc.
    sortDir.value = key === 'displayName' ? 'asc' : 'desc';
  }
  page.value = 1;
}

const search = ref('');

// Roster segment, deep-linked via `?status` (mirrors the Repositories table's
// status filter). `active` = current workspace members; `departed` = ex-members
// (were in the roster, now gone); `external` = never-members (fork imports).
// `all` keeps everyone but ranks member → departed → external (see `sorted`).
type StatusFilter = 'all' | 'active' | 'departed' | 'external';
const statusFilter = computed<StatusFilter>({
  get: () => {
    const v = route.query.status;
    return v === 'active' || v === 'departed' || v === 'external' ? v : 'all';
  },
  set: (v) => {
    const next = { ...route.query };
    if (v === 'all') delete next.status;
    else next.status = v;
    void router.replace({ query: next });
    page.value = 1;
  },
});

const showMethodologyModal = ref(false);

// Fuzzy search tuned to match the ActorPicker so the two behave identically:
// threshold 0.3 + minMatchCharLength 2 keeps the long tail out; weighting
// displayName highest keeps the displayed identity ranking first.
// `aliasSearch` carries every linked account's name/username/email so a
// merged person is findable by a non-primary alias. `ignoreLocation` lets a
// match land anywhere ("han" hits "Zobayer Hasan").
const fuse = computed(
  () =>
    new Fuse(store.members, {
      keys: [
        { name: 'displayName', weight: 3 },
        { name: 'username', weight: 1 },
        { name: 'email', weight: 0.3 },
        { name: 'aliasSearch', weight: 0.5 },
      ],
      threshold: 0.3,
      ignoreLocation: true,
      minMatchCharLength: 2,
    }),
);

const filtered = computed<WorkspaceMember[]>(() => {
  const status = statusFilter.value;
  const wanted: MemberStatus | null =
    status === 'active' ? 'member' : status === 'departed' ? 'departed' : status === 'external' ? 'external' : null;
  const scoped = wanted === null ? store.members : store.members.filter((m) => memberStatus(m) === wanted);
  const q = search.value.trim();
  if (q === '') return scoped;
  // Fuse indexes the full roster, so intersect its hits with the status scope
  // (same object refs → identity Set works).
  const allowed = new Set(scoped);
  return fuse.value
    .search(q)
    .map((r) => r.item)
    .filter((m) => allowed.has(m));
});

const sorted = computed<WorkspaceMember[]>(() => {
  const list = filtered.value.slice();
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const key = sortKey.value;
  // Membership tier is the primary key, regardless of column or direction:
  // active members first, then departed ex-members, then never-member
  // externals. Within a tier the chosen column decides.
  const tier = (m: WorkspaceMember): number =>
    m.membershipStatus === 'member' ? 0 : m.membershipStatus === 'departed' ? 1 : 2;
  list.sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (key === 'displayName') {
      return a.displayName.localeCompare(b.displayName) * dir;
    }
    if (key === 'lastActiveAt') {
      // Nulls last regardless of direction.
      const av = a.lastActiveAt;
      const bv = b.lastActiveAt;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
    }
    if (key === 'scoreTrending' || key === 'consistency90d') {
      // Nulls last regardless of direction.
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

const PAGE_SIZE = 30;
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)));
const pageClamped = computed(() => Math.min(page.value, pageCount.value));
const paged = computed<WorkspaceMember[]>(() => {
  const start = (pageClamped.value - 1) * PAGE_SIZE;
  return sorted.value.slice(start, start + PAGE_SIZE);
});

watch(search, () => {
  page.value = 1;
});

// Compact "2h" / "3d" / "5w" relative time; "—" for null.
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

// Momentum rounds to one decimal (raw sum of log-capped scores, opaque);
// Consistency is a 0–1 ratio shown as a percentage. Both "—" for null.
function formatMomentum(v: number | null): string {
  if (v === null) return '—';
  return v.toFixed(1);
}

function formatConsistency(v: number | null): string {
  if (v === null) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

// Active-members chart buckets: members counted across CUMULATIVE recency
// ranges over 90 days, so count(7d) ≤ count(30d) ≤ count(90d). Rendered as
// separate rows (not stacked) — a stack would double-count overlapping
// members. 90 days aligns with `isDormant`, so the outermost ring is the
// active-vs-dormant boundary used elsewhere in scoring. Emerald darkens
// with recency.
const ACTIVITY_COLORS = {
  active7d: '#047857', // emerald-700
  active30d: '#10b981', // emerald-500
  active90d: '#6ee7b7', // emerald-300
};

const activityBuckets = computed<ActivityBucket[]>(() => {
  const now = Date.now();
  const counts = { a7: 0, a30: 0, a90: 0 };
  for (const m of store.members) {
    if (m.lastActiveAt === null) continue;
    const ageDays = (now - new Date(m.lastActiveAt).getTime()) / DAY_MS;
    // Cumulative — no `else if` chain.
    if (ageDays < 90) counts.a90++;
    if (ageDays < 30) counts.a30++;
    if (ageDays < 7) counts.a7++;
  }
  return [
    { label: 'Active · 7d', count: counts.a7, color: ACTIVITY_COLORS.active7d },
    { label: 'Active · 30d', count: counts.a30, color: ACTIVITY_COLORS.active30d },
    { label: 'Active · 90d', count: counts.a90, color: ACTIVITY_COLORS.active90d },
  ];
});

// Lorenz curve values: 30-day commit counts (same window as the Trend
// sparkline). The component filters zeros — a non-committer doesn't inform
// concentration, and including them would understate the inequality.
const lorenzValues = computed(() => store.members.map((m) => m.commits30d));
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <Breadcrumb :items="[{ label: 'Members', icon: GLYPHS.users }]" />
      <div class="mt-1 flex items-baseline justify-between gap-4">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">Workspace Members</h1>
        <!-- BB members directory link; hidden until workspace is known. -->
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
      <!-- Active vs total, reconciling with the Dashboard's "Workspace
           Members" card (which counts every ingested user). -->
      <p v-if="totalMembers !== null" class="mt-1 text-sm text-slate-500">
        {{ activeMembers }} of {{ totalMembers }} workspace member<span v-if="totalMembers !== 1">s</span> with at least
        one ingested commit<span v-if="inactiveMembers && inactiveMembers > 0">
          · {{ inactiveMembers }} not yet active</span
        >.
      </p>
      <p v-else class="mt-1 text-sm text-slate-500">Every contributor we've ingested at least one commit for.</p>
    </header>

    <!-- Charts run above the filter row: they aggregate the whole roster
         and don't respond to search, so placing them after the input would
         imply the filter applies. Captions live at card level so
         `items-stretch` lines them up across the two cards. -->
    <section class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      <div class="flex flex-col rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-center text-xs font-medium uppercase tracking-wider text-slate-500">
          Tracked Members
          <span class="text-slate-400">({{ store.members.length }})</span>
        </h2>
        <!-- Membership-status partition. Departed = ex-members (were in the
             roster, now gone); External = never-members (fork imports). Both
             are muted and excluded from the leaderboards. -->
        <div class="mb-4 grid grid-cols-3 divide-x divide-slate-200 text-center">
          <div>
            <p class="text-2xl font-semibold tabular-nums text-slate-900">{{ workspaceMemberCount }}</p>
            <p class="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">Members</p>
          </div>
          <div>
            <p class="text-2xl font-semibold tabular-nums text-amber-600">{{ departedCount }}</p>
            <p class="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">Departed</p>
          </div>
          <div>
            <p class="text-2xl font-semibold tabular-nums text-slate-400">{{ externalCount }}</p>
            <p class="mt-0.5 text-[11px] uppercase tracking-wider text-slate-500">External</p>
          </div>
        </div>
        <div class="flex flex-1 items-center justify-center">
          <!-- Nested-range bars (7d / 30d / 90d); see activityBuckets above. -->
          <ActiveMembersBar :buckets="activityBuckets" :bar-height="32" :bar-gap="14" class="w-full max-w-[480px]" />
        </div>
        <p class="mt-4 text-center text-[10px] text-slate-400">
          Members active in the last 7 / 30 / 90 days. Ranges are cumulative.
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
        <!-- Roster segment. Active = current members; Departed = everyone no
             longer in the workspace roster (muted). "All" keeps both, with
             departed sorted below active. Counts are whole-roster, matching
             the tiles above. -->
        <div
          class="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-200 text-xs"
          role="group"
          aria-label="Membership status filter"
        >
          <button
            type="button"
            class="cursor-pointer px-3 py-2 transition"
            :class="statusFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'"
            @click="statusFilter = 'all'"
          >
            All
          </button>
          <button
            type="button"
            class="cursor-pointer border-l border-slate-200 px-3 py-2 transition"
            :class="
              statusFilter === 'active' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            "
            @click="statusFilter = 'active'"
          >
            Active <span class="tabular-nums opacity-70">({{ workspaceMemberCount }})</span>
          </button>
          <button
            type="button"
            class="cursor-pointer border-l border-slate-200 px-3 py-2 transition"
            :class="
              statusFilter === 'departed' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            "
            @click="statusFilter = 'departed'"
          >
            Departed <span class="tabular-nums opacity-70">({{ departedCount }})</span>
          </button>
          <button
            type="button"
            class="cursor-pointer border-l border-slate-200 px-3 py-2 transition"
            :class="
              statusFilter === 'external' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            "
            @click="statusFilter = 'external'"
          >
            External <span class="tabular-nums opacity-70">({{ externalCount }})</span>
          </button>
        </div>
      </div>
      <div class="flex items-center gap-3 text-xs text-slate-500">
        <span>
          {{ sorted.length }} <span v-if="search.trim() !== ''">match{{ sorted.length === 1 ? '' : 'es' }}</span>
          <span v-else>member{{ sorted.length === 1 ? '' : 's' }}</span>
        </span>
        <button
          type="button"
          class="cursor-pointer font-medium text-blue-600 underline-offset-2 transition hover:text-blue-800 hover:underline focus:underline focus:outline-none"
          title="Learn how we calculate Momentum and Consistency"
          @click="showMethodologyModal = true"
        >
          Ranking Logic
        </button>
      </div>
    </section>

    <MethodologyModal v-if="showMethodologyModal" @close="showMethodologyModal = false" />

    <section class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table v-if="paged.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
        <!-- Leaderboard layout (docs/scoring.md). "Momentum" is the
             default sort — the decayed score sum called `scoreTrending`
             in code; the user-facing label avoids "Trending" since it
             sits next to "Trend (30d)" and would read as a boolean.
             Consistency is an independent sortable sibling. -->
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
          <!-- Row muting is a single signal (`isMuted`): every non-member row
               (departed OR external) is muted consistently, plus dormant active
               members. Departed vs external is carried by the status pill next
               to the name and the red email — orthogonal to muting. -->
          <tr
            v-for="m in paged"
            :key="`${m.entityKind}:${m.entityId}`"
            :class="['hover:bg-slate-50', isMuted(m) ? 'bg-slate-50/40 text-slate-400 opacity-70' : '']"
            :title="
              memberStatus(m) === 'external'
                ? 'External contributor — never in the workspace member list'
                : memberStatus(m) === 'departed'
                  ? 'Departed — no longer in the workspace member list'
                  : m.isDormant
                    ? 'Dormant — no eligible activity in the last 90 days'
                    : ''
            "
          >
            <td class="px-2 py-2 text-center align-middle">
              <BadgeIcon :badge="m.badge" :tier="m.badgeTier" />
            </td>
            <td class="max-w-[16rem] px-4 py-2">
              <!-- Person rows → /people/:id, user rows → /users/:id.
                   ×N pill only on person rows with >1 attached alias. -->
              <RouterLink
                :to="
                  m.entityKind === 'person'
                    ? { name: 'person', params: { personId: m.entityId } }
                    : { name: 'user', params: { userId: m.entityId } }
                "
                :class="[
                  'flex items-center gap-1.5 font-medium hover:text-slate-600',
                  isMuted(m) ? 'text-slate-500' : 'text-slate-900',
                ]"
              >
                <span class="min-w-0 truncate" :title="m.displayName">{{ m.displayName }}</span>
                <span
                  v-if="m.entityKind === 'person' && m.attachedUserIds.length > 1"
                  class="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                  :title="`Merged from ${m.attachedUserIds.length} BitBucket accounts`"
                >
                  ×{{ m.attachedUserIds.length }}
                </span>
                <!-- Membership provenance pill — the consistent departed-vs-
                     external marker, independent of dormancy. -->
                <span
                  v-if="memberStatus(m) === 'departed'"
                  class="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                  title="Was a workspace member — since departed"
                >
                  Departed
                </span>
                <span
                  v-else-if="memberStatus(m) === 'external'"
                  class="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                  title="Never a workspace member (fork import / external contributor)"
                >
                  External
                </span>
              </RouterLink>
              <!-- Git-author email (parsed at ingest). Muted for members, RED
                   for non-members (departed or external) — keyed off the same
                   membershipStatus as the pills/muting so the row reads
                   consistently (an org-email member is NOT red). Hidden when null. -->
              <div
                v-if="m.email"
                :class="[
                  'mt-0.5 truncate text-xs',
                  m.membershipStatus === 'member' ? 'text-slate-400' : 'text-red-600',
                ]"
                :title="
                  memberStatus(m) === 'member'
                    ? m.email
                    : memberStatus(m) === 'departed'
                      ? `${m.email} — departed member (no longer in the workspace roster)`
                      : `${m.email} — external contributor (never a workspace member)`
                "
              >
                {{ m.email }}
              </div>
            </td>
            <td class="px-4 py-2">
              <Sparkline :points="m.last30Days" :width="96" :height="18" class="mx-auto block text-slate-400" />
            </td>
            <td class="px-4 py-2 text-center tabular-nums" :class="isMuted(m) ? 'text-slate-400' : 'text-slate-900'">
              {{ formatMomentum(m.scoreTrending) }}
            </td>
            <td class="px-4 py-2 text-center tabular-nums" :class="isMuted(m) ? 'text-slate-400' : 'text-slate-700'">
              {{ formatConsistency(m.consistency90d) }}
            </td>
            <td class="px-4 py-2 text-center text-slate-500" :title="m.lastActiveAt ?? ''">
              {{ relativeTime(m.lastActiveAt) }}
            </td>
            <!-- Per-window: commit count + distinct-repo count in parens
                 (muted) as supplementary breadth context. -->
            <td class="px-4 py-2 text-center tabular-nums" :class="isMuted(m) ? 'text-slate-500' : 'text-slate-900'">
              {{ m.commits7d }}
              <span class="ml-1 text-xs font-normal text-slate-400">({{ m.repos7d }})</span>
            </td>
            <td class="px-4 py-2 text-center tabular-nums" :class="isMuted(m) ? 'text-slate-500' : 'text-slate-900'">
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

    <section class="mb-4 mt-8">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <label for="members-activity-filter-project" class="flex items-center gap-1">
            <span class="text-slate-500">Project:</span>
            <select
              id="members-activity-filter-project"
              v-model="filterProject"
              name="members-activity-filter-project"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter activity by project"
            >
              <option :value="undefined">All</option>
              <option v-for="p in activityProjectOptions" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
          <label for="members-activity-filter-repo" class="flex items-center gap-1">
            <span class="text-slate-500">Repository:</span>
            <select
              id="members-activity-filter-repo"
              v-model="filterRepo"
              name="members-activity-filter-repo"
              class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
              aria-label="Filter activity by repository"
            >
              <option :value="undefined">All</option>
              <option v-for="r in activityRepoOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
            </select>
          </label>
          <label for="members-activity-filter-user" class="flex items-center gap-1">
            <span class="text-slate-500">Contributor:</span>
            <ActorPicker id="members-activity-filter-user" v-model="filterActor" />
          </label>
          <button
            v-if="activityFiltersActive"
            type="button"
            class="cursor-pointer text-slate-500 hover:text-slate-700"
            @click="clearActivityFilters"
          >
            Clear
          </button>
        </div>
      </div>
      <ActivityFeed :actor="filterActor" :project="filterProject" :repo="filterRepo" height="24rem">
        <template #footer>
          <RouterLink
            :to="{ name: 'activity', query: { after: activitySinceThirtyDays } }"
            class="block border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          >
            See all activities →
          </RouterLink>
        </template>
      </ActivityFeed>
    </section>
  </main>
</template>
