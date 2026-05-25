<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import StatCard from '@/components/StatCard.vue';
import ActivityFeed from '@/components/ActivityFeed.vue';
import BadgeIcon from '@/components/BadgeIcon.vue';
import CommitHeatmap from '@/components/CommitHeatmap.vue';
import SyncStateIcon from '@/components/SyncStateIcon.vue';
import { usePersonSummaryStore } from '@/stores/personSummary';
import { useStatsStore } from '@/stores/stats';
import { useActivityFilters } from '@/composables/useActivityFilters';
import type { ActivityActor } from '@/api/client';

const route = useRoute();
const store = usePersonSummaryStore();
const stats = useStatsStore();

const personId = computed(() => Number(route.params.personId));
const summary = computed(() => store.byPersonId[personId.value]);
const loading = computed(() => store.loading[personId.value] === true);
const error = computed(() => store.error[personId.value] ?? null);

// All attached aliases' git-author emails, de-duped, comma-separated.
// A merged person can carry several (one per account); the header
// marquees them so none are hidden.
const emails = computed(() => {
  if (summary.value === undefined) return '';
  const seen = new Set<string>();
  const list: string[] = [];
  for (const a of summary.value.attachedUsers) {
    if (a.email !== null && !seen.has(a.email)) {
      seen.add(a.email);
      list.push(a.email);
    }
  }
  return list.join(', ');
});

// Email marquee — a left↔right *bounce*, not a rotating loop. We measure
// how far the text overflows its capped-width container; if it fits,
// nothing animates (static, left-aligned). If it overflows, the CSS
// animation pauses at the start, scrolls left until the last character
// reaches the right edge (`--email-shift` = -overflow px), pauses, then
// scrolls back. A single copy means no second block ever peeks in.
const emailContainer = ref<HTMLElement | null>(null);
const emailText = ref<HTMLElement | null>(null);
const shiftPx = ref(0);
const overflowing = computed(() => shiftPx.value > 0);
// Scroll phases occupy ~38% of the cycle each (see keyframes); scale the
// duration with the distance so the scroll speed stays roughly constant
// regardless of how long the email list is.
const durationSec = computed(() => Math.max(8, Math.round(shiftPx.value / 18)));

function measureMarquee(): void {
  const c = emailContainer.value;
  const t = emailText.value;
  shiftPx.value = c === null || t === null ? 0 : Math.max(0, t.scrollWidth - c.clientWidth);
}

onMounted(() => {
  void store.fetch(personId.value);
  // The repo list powers the project + repo activity-filter dropdowns;
  // a deep link into /people/:id won't have the dashboard's prior fetch.
  void stats.fetchOverview();
  void nextTick(measureMarquee);
  window.addEventListener('resize', measureMarquee);
});
onUnmounted(() => window.removeEventListener('resize', measureMarquee));
watch(personId, (next) => void store.fetch(next));
// Re-measure once the email text actually changes / lands (async fetch,
// or navigating between people).
watch(emails, () => void nextTick(measureMarquee));

// The feed actor is the person itself — the backend expands it to every
// attached alias, so the feed shows the merged contributor's full
// commit + PR stream across all their accounts.
const personActor = computed<ActivityActor>(() => ({ kind: 'person', id: personId.value }));

// Project + repo filters narrow the person's feed. The person is pinned
// (page subject), so there's no contributor dropdown. The composable
// owns the URL sync + project↔repo interlock.
const {
  projectModel: filterProject,
  repoModel: filterRepo,
  repoOptions: repoFilterOptions,
} = useActivityFilters({
  repositories: computed(() => stats.repositories),
});
const projectOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const r of stats.repositories) if (r.project !== null) set.add(r.project);
  return Array.from(set).sort();
});

// 30-day cutoff for the "See all activities →" link; matches the
// Activity page's range-preset detection so its title chip lights up.
const DAY_MS = 86_400_000;
function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const activitySinceThirtyDays = computed(() => localDateString(new Date(Date.now() - 30 * DAY_MS)));

// Compact "time ago" for the attached-accounts table's Last active column
// (mirrors the Members table formatter). "—" when the alias has no commits.
function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const diffSec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
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
</script>

<template>
  <main class="mx-auto max-w-6xl px-6 py-8">
    <header class="mb-6">
      <RouterLink to="/members" class="text-xs text-slate-500 hover:text-slate-700">← Members</RouterLink>
      <div class="mt-1 flex items-center gap-3">
        <h1 class="text-3xl font-bold tracking-tight text-slate-900">
          {{ summary?.person.displayName ?? `Person #${personId}` }}
        </h1>
        <BadgeIcon
          v-if="summary && summary.person.badge"
          :badge="summary.person.badge"
          :tier="summary.person.badgeTier"
        />
        <!-- Merged-identity marker, after the badge so the persona reads
             first. -->
        <span
          v-if="summary"
          class="inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700"
          :title="`Merged from ${summary.attachedUsers.length} BitBucket account(s)`"
        >
          merged ×{{ summary.attachedUsers.length }}
        </span>
      </div>
      <!-- Every alias's git-author email, comma-separated. Capped width;
           a single copy that bounces left↔right only when it overflows
           (static otherwise). Full string is in the title tooltip. -->
      <div v-if="emails" ref="emailContainer" class="mt-1 max-w-md overflow-hidden" :title="emails">
        <div
          ref="emailText"
          class="inline-block whitespace-nowrap text-xs text-slate-400"
          :class="{ 'email-bounce': overflowing }"
          :style="overflowing ? { '--email-shift': `-${shiftPx}px`, '--email-dur': `${durationSec}s` } : undefined"
        >
          {{ emails }}
        </div>
      </div>
    </header>

    <p v-if="loading && !summary" class="text-sm text-slate-400">Loading…</p>
    <p v-if="error" class="mb-4 text-sm text-red-600">Could not load summary: {{ error }}</p>

    <template v-if="summary">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Commits — last 7 days" :value="summary.totals.commits7d" />
        <StatCard label="Commits — last 30 days" :value="summary.totals.commits30d" />
        <StatCard label="Commits — all time" :value="summary.totals.commitsAllTime" />
        <StatCard label="Repositories — all time" :value="summary.totals.repositoriesAllTime ?? 0" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Activity — last 365 days</h2>
        <CommitHeatmap :data="summary.dailyCommits" scope="user" />
      </section>

      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Top repos — last 30 days</h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table v-if="summary.topRepos.length > 0" class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="w-8 px-2 py-2 text-center font-medium"><span class="sr-only">Sync state</span></th>
                <th class="px-4 py-2 text-left font-medium">Repository</th>
                <th class="px-4 py-2 text-left font-medium">Project</th>
                <th colspan="3" class="py-2 pl-1 pr-4 text-right font-medium">Changes</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="r in summary.topRepos" :key="r.fullName">
                <td class="px-2 py-2 text-center align-middle">
                  <SyncStateIcon :status="r.syncStatus" />
                </td>
                <td class="px-4 py-2">
                  <RouterLink
                    :to="{ name: 'repository', params: { workspace: r.workspace, slug: r.slug } }"
                    class="font-medium text-slate-900 hover:text-slate-600"
                  >
                    {{ r.slug }}
                  </RouterLink>
                </td>
                <td class="px-4 py-2">
                  <RouterLink
                    v-if="r.project"
                    :to="{ name: 'project', params: { projectKey: r.project } }"
                    class="text-slate-700 hover:text-slate-500"
                  >
                    {{ r.project }}
                  </RouterLink>
                  <span v-else class="text-slate-400">—</span>
                </td>
                <td class="w-20 px-1 py-2 text-right text-xs tabular-nums">
                  <span class="text-emerald-700">+{{ r.additions30d.toLocaleString() }}</span>
                </td>
                <td class="w-20 px-1 py-2 text-right text-xs tabular-nums">
                  <span class="text-rose-700">−{{ r.deletions30d.toLocaleString() }}</span>
                </td>
                <td class="w-28 whitespace-nowrap py-2 pl-4 pr-4 text-right text-slate-500">
                  {{ r.commits.toLocaleString() }} commit<span v-if="r.commits !== 1">s</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="px-4 py-6 text-center text-sm text-slate-400">No repos in the last 30 days.</p>
        </div>
      </section>

      <!-- Attached accounts — the underlying BB aliases this person was
           merged from. Each links to its per-alias /users/:id page,
           which keeps its own single-account history view. The primary
           alias (supplies the person's avatar / email defaults) is
           flagged. Last active is per-alias; the person's own last-active
           (shown in the Members table) is the max across these rows. -->
      <section class="mt-8">
        <h2 class="mb-3 text-lg font-semibold text-slate-900">Attached accounts</h2>
        <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table class="min-w-full divide-y divide-slate-100 text-sm">
            <thead class="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th class="px-4 py-2 text-left font-medium">Account</th>
                <th class="px-4 py-2 text-left font-medium">Email</th>
                <th class="px-4 py-2 text-left font-medium">BitBucket UUID</th>
                <th class="px-4 py-2 text-center font-medium">Last active</th>
                <th class="px-4 py-2 text-center font-medium">Primary</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr v-for="a in summary.attachedUsers" :key="a.id" class="hover:bg-slate-50">
                <td class="px-4 py-2">
                  <RouterLink
                    :to="{ name: 'user', params: { userId: a.id } }"
                    class="font-medium text-slate-900 hover:text-slate-600"
                  >
                    {{ a.displayName }}
                  </RouterLink>
                  <span v-if="a.username" class="ml-1 text-xs text-slate-400">@{{ a.username }}</span>
                </td>
                <td class="px-4 py-2 text-slate-500">
                  <span v-if="a.email">{{ a.email }}</span>
                  <span v-else class="text-slate-300">—</span>
                </td>
                <td class="px-4 py-2 font-mono text-xs text-slate-400">{{ a.bitbucketUuid }}</td>
                <td class="px-4 py-2 text-center text-slate-500" :title="a.lastActiveAt ?? ''">
                  {{ relativeTime(a.lastActiveAt) }}
                </td>
                <td class="px-4 py-2 text-center">
                  <span
                    v-if="a.isPrimary"
                    class="inline-block rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
                    >primary</span
                  >
                  <span v-else class="text-slate-300">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="mt-8">
        <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 class="text-lg font-semibold text-slate-900">Activity</h2>
          <!-- Project + repo filters scoped to this person. The person is
               pinned via `:actor` on the feed below (the backend expands
               it to all attached aliases), so there's no contributor
               dropdown here. The composable wires the project↔repo
               interlock. -->
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <label for="person-filter-project" class="flex items-center gap-1">
              <span class="text-slate-500">Project:</span>
              <select
                id="person-filter-project"
                v-model="filterProject"
                name="person-filter-project"
                class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
                aria-label="Filter by project"
              >
                <option :value="undefined">All</option>
                <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
            <label for="person-filter-repo" class="flex items-center gap-1">
              <span class="text-slate-500">Repository:</span>
              <select
                id="person-filter-repo"
                v-model="filterRepo"
                name="person-filter-repo"
                class="rounded border border-slate-200 bg-white px-2 py-1 text-slate-900"
                aria-label="Filter by repository"
              >
                <option :value="undefined">All</option>
                <option v-for="r in repoFilterOptions" :key="r.fullName" :value="r.fullName">{{ r.slug }}</option>
              </select>
            </label>
          </div>
        </div>
        <ActivityFeed :actor="personActor" :project="filterProject" :repo="filterRepo" height="24rem">
          <template #footer>
            <!-- "See all activities →" pre-applies this person so the
                 dedicated /activity page lands on the same merged scope. -->
            <RouterLink
              :to="{
                name: 'activity',
                query: { actor: personId, actorKind: 'person', after: activitySinceThirtyDays },
              }"
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

<style scoped>
/* Email bounce: a single text copy ping-pongs only when it overflows.
   Pause at the start (0–12%), scroll left until the end reaches the
   right edge (`--email-shift` px, set inline from the measured
   overflow) by 50%, pause there (50–62%), then scroll back to the
   start by 100%. `linear` keeps a constant scroll speed; the duration
   (`--email-dur`) scales with the distance so speed is stable across
   email-list lengths. No class is applied when the text fits, so it
   stays static and left-aligned. */
.email-bounce {
  animation: email-bounce var(--email-dur, 12s) linear infinite;
}
.email-bounce:hover {
  animation-play-state: paused;
}
@keyframes email-bounce {
  0%,
  12% {
    transform: translateX(0);
  }
  50%,
  62% {
    transform: translateX(var(--email-shift, 0));
  }
  100% {
    transform: translateX(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .email-bounce {
    animation: none;
  }
}
</style>
