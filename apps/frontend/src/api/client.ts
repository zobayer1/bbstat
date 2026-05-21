const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new ApiError(`Request failed: ${res.status}`, res.status);
  return (await res.json()) as T;
}

export interface OverviewStats {
  // Count of distinct users with at least one attributed commit
  // (matches the Members page roster). Earlier called `users` — that
  // counted every row in the users table including never-committed
  // workspace members, so the dashboard card and Members page total
  // didn't line up.
  contributors: number;
  repositories: number;
  projects: number;
  totalCommits: number;
  commitsLast7Days: number;
  commitsLast30Days: number;
}

export interface LatestCommit {
  sha: string;
  message: string;
  authoredAt: string;
  authorDisplayName: string | null;
  authorBitbucketUuid: string | null;
}

export interface TopContributor {
  userId: number;
  bitbucketUuid: string;
  displayName: string;
  commits: number;
}

// Phase 4 T24 — top-contributors leaderboard rows additionally carry a
// 30-day per-day commit-count series for the sparkline on the Dashboard's
// Top Contributors panel. Project / repo contributor lists stay on the
// base shape.
export interface TopContributorWithSparkline extends TopContributor {
  last30Days: number[];
  // Adds / dels for the same window as `commits` (merges excluded).
  additionsWindow: number;
  deletionsWindow: number;
  // Distinct repos this contributor landed code in over the same
  // window. Mirrors the Members table's "Repos" column.
  reposWindow: number;
  // ShipShow Score signals (docs/scoring.md). Server orders the list
  // by `momentum DESC NULLS LAST` so the Dashboard panel surfaces the
  // top-of-the-cohort regardless of window-scoped commit count; the
  // per-row bar normalises consistency relative to the displayed
  // group. Both fields may be null for users whose user_score row
  // hasn't landed yet, or for cold-start consistency.
  momentum: number | null;
  consistency90d: number | null;
}

// Time window for the Dashboard "Top Contributors" panel — narrow
// 7d/30d contract that the /api/stats/top-contributors route accepts.
// The Members page no longer takes a window parameter (it ships both
// 7d + 30d aggregates per row), so the only consumer of this type is
// the dashboard top-contributors call.
export type ContributorWindow = '7d' | '30d';

// Phase 3 per-entity rollup endpoints. Shapes mirror the StatsStore result
// types in apps/backend/src/dashboard/stats-store.ts — keep in lockstep.

export interface UserSummary {
  user: {
    id: number;
    bitbucketUuid: string;
    displayName: string;
    email: string | null;
    // ShipShow Score badge + tier surfaced next to the displayName on
    // the user detail page. Null when no user_score row yet, or when
    // the dev is dormant / no persona matched.
    badge: UserBadge | null;
    badgeTier: UserBadgeTier | null;
  };
  totals: {
    commits7d: number;
    commits30d: number;
    commitsAllTime: number;
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
    repositoriesAllTime: number;
  };
  dailyCommits: Array<{ date: string; commits: number }>;
  topRepos: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    project: string | null;
    commits: number;
    syncStatus: RepoSyncStatus;
    additions30d: number;
    deletions30d: number;
  }>;
}

export interface ProjectStats {
  project: string;
  totals: {
    commits7d: number;
    commits30d: number;
    contributorCount7d: number;
    repositoryCount: number;
  };
  dailyCommits: Array<{ date: string; commits: number }>;
  // Project-scoped contributor table — same enriched shape as the
  // repo detail page's per-repo contributors (30-day sparkline + adds /
  // dels excluding merges) so both pages reuse the same row layout.
  topContributors: RepoContributor[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
    contributors30d: number;
    lastCommitAt: string | null;
    syncStatus: RepoSyncStatus;
  }>;
}

// 4-state sync health derived server-side from sync_state.last_sync_status
// + repositories.sync_excluded. 'ok' covers both 'success' and in-flight
// 'running'; 'error' is a failed most-recent attempt; 'never' is a
// tracked repo no sync has touched yet; 'excluded' is an auto-trip
// (404 / empty-on-BB / history-rewritten) needing an admin recovery
// action via /include, /rename, or DELETE.
export type RepoSyncStatus = 'ok' | 'error' | 'never' | 'excluded';

export interface RepoActivity {
  repository: {
    workspace: string;
    slug: string;
    fullName: string;
    project: string | null;
    syncStatus: RepoSyncStatus;
  };
  dailyCommits: Array<{ date: string; commits: number; additions: number; deletions: number }>;
  // Per-window code-change summary, excluding merge commits. Always
  // returned now that per-repo opt-in is gone; reads zero on rows
  // whose diff-stats haven't been ingested yet (transient — the
  // backfill tick chases freshness first).
  diffStats: {
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
  };
  // Sparkline `last30Days` is scoped to this repo (this user's commits in
  // this repo, day-by-day over the trailing 30 days). Same shape as the
  // dashboard's top-contributors list so the Sparkline component renders
  // unchanged. Diff-stat fields are 30-day, exclude merges, read zero
  // when no diff-stat fetch has landed for any of this user's commits.
  contributors: RepoContributor[];
}

export interface RepoContributor extends TopContributorWithSparkline {
  additions30d: number;
  deletions30d: number;
}

// Mirrors the bbstat.user_badge Postgres enum + the `Badge` type in
// apps/backend/src/scoring/badge.ts. Keep all three in lockstep when
// adding / removing badges. Display labels for these slugs live in
// the BadgeIcon component.
export type UserBadge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

// Within-persona tier. Today only `steady_eddie` carries one; the
// frontend renders it as a colored ring around the badge icon.
export type UserBadgeTier = 'bronze' | 'silver' | 'gold';

// One row on the /members page. Mirror of WorkspaceMember in
// apps/backend/src/dashboard/stats-store.ts — keep in lockstep.
// `email` is the git-author email parsed from commits.author.raw on
// ingest — best-effort, not a verified workspace email. See the
// comment on users.email in schema.ts for caveats.
export interface WorkspaceMember {
  userId: number;
  bitbucketUuid: string;
  displayName: string;
  username: string | null;
  email: string | null;
  // Mirrors users.is_workspace_member — TRUE for current workspace
  // members (discovered via member sync), FALSE for ex-employees /
  // never-members / externals (auto-created during commit ingest or
  // by the anonymous-sweep runner). Drives the Members table's
  // muted styling for out-of-workspace contributors.
  isWorkspaceMember: boolean;
  // Both windows ship in every row so the table can render
  // `{commits} ({repos})` cells side-by-side for 7d and 30d without
  // re-fetching on toggle.
  commits7d: number;
  repos7d: number;
  commits30d: number;
  repos30d: number;
  commitsAllTime: number;
  reposAllTime: number;
  lastActiveAt: string | null;
  last30Days: number[];
  // ShipShow Score columns (docs/scoring.md). LEFT-JOINed from
  // user_score on the backend — null when the row isn't written yet
  // (between member sync and the next commits-sync tick). The table
  // sorts by scoreTrending DESC by default.
  scoreTrending: number | null;
  consistency90d: number | null;
  badge: UserBadge | null;
  // Within-persona tier (only steady_eddie carries one today). Drives
  // the colored ring around the badge icon.
  badgeTier: UserBadgeTier | null;
  isDormant: boolean;
}

export interface TrackedRepositorySummary {
  workspace: string;
  slug: string;
  fullName: string;
  project: string | null;
  commits30d: number;
  contributors30d: number;
  // 30-day non-merge diff totals. Surfaced for the Repositories
  // index's compound bar chart; reads zero on repos whose diff-stat
  // ingest hasn't landed yet (transient).
  additions30d: number;
  deletions30d: number;
  lastCommitAt: string | null;
  syncStatus: RepoSyncStatus;
}

// Phase 4 T23 — unified activity feed payload. Discriminated by `kind`.
// `occurredAt` is commits.authored_at for commits and
// pull_requests.bitbucket_updated_at for PRs, so a PR's row can resurface
// in the feed each time it gets a state transition or comment churn.

export interface ActivityRepository {
  workspace: string;
  slug: string;
  fullName: string;
}

export interface ActivityAuthor {
  userId: number;
  displayName: string;
  bitbucketUuid: string;
}

export interface ActivityCommit {
  kind: 'commit';
  sha: string;
  message: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  isMerge: boolean;
  // True when the diff-stats orchestrator gave up fetching diffs for
  // this commit (typically HTTP 555 — BB compute timeout). The +/-/files
  // row in the UI swaps for an exclamation icon when this is true;
  // additions / deletions / filesChanged will all be 0 (the stamp-with-
  // zeros pattern that drops the commit out of the backfill pickup),
  // so renderers MUST branch on this flag, not on a "values are zero"
  // heuristic, or the icon swap won't happen.
  diffStatsUnavailable: boolean;
  repository: ActivityRepository;
  author: ActivityAuthor | null;
  occurredAt: string;
}

export interface ActivityPullRequest {
  kind: 'pr';
  prId: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  sourceBranch: string;
  destinationBranch: string;
  repository: ActivityRepository;
  author: ActivityAuthor | null;
  occurredAt: string;
}

export type ActivityEntry = ActivityCommit | ActivityPullRequest;

export interface RepoContributorBreakdown {
  workspace: string;
  slug: string;
  fullName: string;
  project: string | null;
  commits: number;
  contributors: Array<{ userId: number; displayName: string; commits: number }>;
}

export interface ActivityQuery {
  actor?: number;
  repo?: string; // "<workspace>/<slug>"
  project?: string;
  before?: string; // ISO 8601 — cursor / range upper bound (exclusive)
  after?: string; // ISO 8601 — range lower bound (inclusive)
  hashPrefix?: string; // 1–40 hex chars; suppresses PRs server-side
  message?: string; // 2–200 chars; FTS on commits, ILIKE on PR titles
  limit?: number; // default 50, max 200
  // Offset-based pagination (Activity page only). Embedded feed leaves
  // this undefined and uses `before` as a cursor instead.
  offset?: number;
}

// Shared query-string builder for /api/activity + /api/activity-count.
// Same field set, same URL encoding — extracted so the two callers
// can't drift on which params they include.
function encodeActivityQuery(query: ActivityQuery): string {
  const params = new URLSearchParams();
  if (query.actor !== undefined) params.set('actor', String(query.actor));
  if (query.repo !== undefined) params.set('repo', query.repo);
  if (query.project !== undefined) params.set('project', query.project);
  if (query.before !== undefined) params.set('before', query.before);
  if (query.after !== undefined) params.set('after', query.after);
  if (query.hashPrefix !== undefined) params.set('hashPrefix', query.hashPrefix);
  if (query.message !== undefined) params.set('message', query.message);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  return params.toString();
}

export const api = {
  health: () => request<{ status: string; uptime: number }>('/healthz'),
  statsOverview: () => request<OverviewStats>('/api/stats/overview'),
  latestCommit: (workspace: string, slug: string) =>
    request<LatestCommit>(
      `/api/stats/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/latest-commit`,
    ),
  topContributors: (window: ContributorWindow = '7d') =>
    request<TopContributorWithSparkline[]>(`/api/stats/top-contributors?window=${window}`),
  userSummary: (userId: number) => request<UserSummary>(`/api/stats/users/${userId}/summary`),
  projectStats: (projectKey: string) => request<ProjectStats>(`/api/stats/projects/${encodeURIComponent(projectKey)}`),
  repositoryActivity: (workspace: string, slug: string) =>
    request<RepoActivity>(
      `/api/stats/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/activity`,
    ),
  listRepositories: () => request<TrackedRepositorySummary[]>('/api/stats/repositories'),
  repoContributorBreakdown: (
    query: { windowDays?: number; topRepos?: number; topPerRepo?: number; project?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.windowDays !== undefined) params.set('windowDays', String(query.windowDays));
    if (query.topRepos !== undefined) params.set('topRepos', String(query.topRepos));
    if (query.topPerRepo !== undefined) params.set('topPerRepo', String(query.topPerRepo));
    if (query.project !== undefined) params.set('project', query.project);
    const qs = params.toString();
    return request<RepoContributorBreakdown[]>(`/api/stats/repo-contributors${qs.length > 0 ? `?${qs}` : ''}`);
  },
  members: () => request<WorkspaceMember[]>('/api/stats/members'),
  activityDaily: (query: { actor?: number; repo?: string; project?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.actor !== undefined) params.set('actor', String(query.actor));
    if (query.repo !== undefined) params.set('repo', query.repo);
    if (query.project !== undefined) params.set('project', query.project);
    const qs = params.toString();
    return request<{ date: string; commits: number }[]>(`/api/activity-daily${qs.length > 0 ? `?${qs}` : ''}`);
  },
  activity: (query: ActivityQuery = {}) => {
    const qs = encodeActivityQuery(query);
    return request<ActivityEntry[]>(`/api/activity${qs.length > 0 ? `?${qs}` : ''}`);
  },
  activityCount: (query: ActivityQuery = {}) => {
    const qs = encodeActivityQuery(query);
    return request<{ total: number }>(`/api/activity-count${qs.length > 0 ? `?${qs}` : ''}`);
  },
};

// ----------------------------------------------------------------------------
// Live updates (Server-Sent Events at /api/live)
//
// Frontend mirror of the slim payloads the backend publishes on its event
// bus. See apps/backend/src/events/bus.ts for the canonical definitions —
// these must stay in lockstep. Frontend wraps them in a typed event map
// consumed by `lib/live.ts`.
// ----------------------------------------------------------------------------

export interface TickCommitsCompletePayload {
  trigger: 'manual' | 'cron' | 'webhook';
  startedAt: string;
  finishedAt: string;
  attempted: number;
  deferred: number;
  errors: number;
  totalCommitsInserted: number;
  budgetRemainingAtEnd: number;
  stoppedEarly: boolean;
  deepenStoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete' | null;
  isMergeBackfillStoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete' | null;
  diffStatsBackfillStopReason: 'budget' | 'rate-limited' | null;
  diffStatsBackfillTotalUpdated: number;
}

export interface TickPrsCompletePayload {
  trigger: 'manual' | 'cron' | 'webhook';
  startedAt: string;
  finishedAt: string;
  attempted: number;
  deferred: number;
  errors: number;
  totalPrsInserted: number;
  totalPrsUpdated: number;
  budgetRemainingAtEnd: number;
  stoppedEarly: boolean;
}

export interface RepositoryExcludedPayload {
  repositoryId: number;
  fullName: string;
  reason: 'repo-404' | 'history-rewritten' | 'empty-on-bitbucket';
}

export interface RepositoryIncludedPayload {
  repositoryId: number;
  fullName: string;
  source: 'include' | 'rename';
}

export interface RepositoryDeletedPayload {
  repositoryId: number;
  fullName: string;
}

// Map from event-name → payload shape. `lib/live.ts` uses this for
// type-safe handler registration (`bus.on('tick.commits.complete', p => ...)`).
export interface LiveEventMap {
  'tick.commits.complete': TickCommitsCompletePayload;
  'tick.prs.complete': TickPrsCompletePayload;
  'repository.sync-excluded': RepositoryExcludedPayload;
  'repository.included': RepositoryIncludedPayload;
  'repository.deleted': RepositoryDeletedPayload;
}

export type LiveEventName = keyof LiveEventMap;
