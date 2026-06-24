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
  // Distinct users with ≥1 attributed commit (matches the Members roster).
  // Not a raw users-table count — that included never-committed members.
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

// Dashboard org-wide Top Contributors row, keyed on the merged entity (person
// or unattached user). Mirror of TopContributorEntity in
// apps/backend/src/dashboard/stats-store.ts. Per-repo / per-project lists use
// the trimmed RepoContributorEntity variant.
export interface TopContributorEntity {
  entityKind: 'user' | 'person';
  entityId: number;
  // Primary-first attached user_ids (length 1 for user rows). The activity
  // filter uses attachedUserIds[0] since the feed is single-actor — persons
  // resolve to their primary alias until multi-actor filtering lands.
  attachedUserIds: number[];
  bitbucketUuid: string | null;
  displayName: string;
  commits: number;
  last30Days: number[];
  additionsWindow: number;
  deletionsWindow: number;
  reposWindow: number;
  momentum: number | null;
  consistency90d: number | null;
}

// Window the /api/stats/top-contributors route accepts. Only consumer is the
// dashboard top-contributors call (the Members page ships both windows per row).
export type ContributorWindow = '7d' | '30d';

// Per-entity rollup endpoints. Shapes mirror the StatsStore result types in
// apps/backend/src/dashboard/stats-store.ts — keep in lockstep.

export interface UserSummary {
  user: {
    id: number;
    bitbucketUuid: string;
    displayName: string;
    email: string | null;
    // Null when no user_score row yet, or the dev is dormant / no persona.
    badge: UserBadge | null;
    badgeTier: UserBadgeTier | null;
    // Non-null when attached to a person — drives the "Part of: <name>"
    // banner linking to /people/:id. Null when unattached.
    person: { id: number; displayName: string } | null;
  };
  // Sibling aliases merged into the same person (this account excluded);
  // empty for an unattached user. Drives the "Linked accounts" table.
  linkedAccounts: Array<{
    id: number;
    bitbucketUuid: string;
    displayName: string;
    username: string | null;
    email: string | null;
    isPrimary: boolean;
    lastActiveAt: string | null;
  }>;
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
    // Distinct contributors over 30d, person-aware (aliases collapse to one).
    contributorCount30d: number;
    repositoryCount: number;
  };
  dailyCommits: Array<{ date: string; commits: number }>;
  // Same entity-keyed shape as the repo detail page's contributors.
  topContributors: RepoContributorEntity[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
    // Per-repo distinct contributors, person-aware.
    contributors30d: number;
    lastCommitAt: string | null;
    syncStatus: RepoSyncStatus;
  }>;
}

// Sync health derived server-side from sync_state.last_sync_status +
// repositories.sync_excluded. 'ok' = success or in-flight running; 'error' =
// last attempt failed; 'never' = untouched; 'excluded' = auto-trip (404 /
// history-rewritten) needing an admin fix via /include, /rename, or DELETE;
// 'empty' = benign (empty on BitBucket, nothing to sync) — kept distinct from
// 'excluded' so the Repositories page doesn't flag empty repos as problems.
export type RepoSyncStatus = 'ok' | 'error' | 'never' | 'excluded' | 'empty';

export interface RepoActivity {
  repository: {
    workspace: string;
    slug: string;
    fullName: string;
    project: string | null;
    syncStatus: RepoSyncStatus;
    archived: boolean;
  };
  dailyCommits: Array<{ date: string; commits: number; additions: number; deletions: number }>;
  // Per-window code-change summary, excluding merge commits. Reads zero on
  // rows whose diff-stats haven't been ingested yet (transient).
  diffStats: {
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
  };
  // Keyed on the merged entity — a person's aliases that both touched this
  // repo collapse into one row. `last30Days` is repo-scoped (this entity's
  // commits in this repo, day-by-day). Diff-stat fields are 30-day, exclude
  // merges, read zero before a diff-stat fetch lands.
  contributors: RepoContributorEntity[];
}

// Mirror of RepoContributorEntity in the backend stats-store. Repo-detail
// contributor row keyed on the merged entity.
export interface RepoContributorEntity {
  entityKind: 'user' | 'person';
  entityId: number;
  attachedUserIds: number[];
  bitbucketUuid: string | null;
  displayName: string;
  commits: number;
  last30Days: number[];
  additions30d: number;
  deletions30d: number;
}

// Mirrors the bbstat.user_badge Postgres enum + the `Badge` type in
// apps/backend/src/scoring/badge.ts — keep all three in lockstep. Display
// labels for these slugs live in the BadgeIcon component.
export type UserBadge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

// Within-persona tier — today only `steady_eddie` carries one.
export type UserBadgeTier = 'bronze' | 'silver' | 'gold';

// One /members leaderboard row. Mirror of WorkspaceMember in
// apps/backend/src/dashboard/stats-store.ts — keep in lockstep. Each row is an
// unattached user or a merged person, discriminated by `entityKind`. `email`
// is the git-author email parsed from commits.author.raw on ingest —
// best-effort, not a verified workspace email (see users.email in schema.ts).
export interface WorkspaceMember {
  // 'user' → unattached user; entityId is users.id; link to /users/:id.
  // 'person' → merged person; entityId is people.id; link to /people/:id.
  entityKind: 'user' | 'person';
  entityId: number;
  // Primary alias's UUID for person rows; the user's own for user rows.
  // Null only for a person with aliases but no primary flagged (edge).
  bitbucketUuid: string | null;
  displayName: string;
  username: string | null;
  email: string | null;
  // Person rows: OR across attached aliases. User rows: the user's own.
  // Drives muted styling for out-of-workspace contributors.
  isWorkspaceMember: boolean;
  // user_ids behind this row, primary-first (length 1 for user rows). Drives
  // the "merged from N accounts" pill and tells SSE handlers which per-user
  // caches to drop.
  attachedUserIds: number[];
  // Search-only — every attached alias's name / username / email concatenated
  // so a merged person is findable by any linked account. Fuse key on the
  // Members table + ActorPicker; never rendered.
  aliasSearch: string;
  // Both windows ship per row so the table renders `{commits} ({repos})` for
  // 7d and 30d without re-fetching on toggle.
  commits7d: number;
  repos7d: number;
  commits30d: number;
  repos30d: number;
  commitsAllTime: number;
  reposAllTime: number;
  lastActiveAt: string | null;
  last30Days: number[];
  // ShipShow Score columns (docs/scoring.md), from the leaderboard_entries
  // view. Null until the row is written (between member sync and the next
  // commits-sync tick). Table sorts by scoreTrending DESC by default.
  scoreTrending: number | null;
  consistency90d: number | null;
  badge: UserBadge | null;
  badgeTier: UserBadgeTier | null;
  isDormant: boolean;
}

// Person detail page payload. Mirror of PersonSummary in
// apps/backend/src/dashboard/stats-store.ts. Same shape as UserSummary plus
// the `attachedUsers` roster of underlying aliases.
export interface PersonSummary {
  person: {
    id: number;
    displayName: string;
    bitbucketUuid: string | null;
    email: string | null;
    badge: UserBadge | null;
    badgeTier: UserBadgeTier | null;
  };
  attachedUsers: Array<{
    id: number;
    bitbucketUuid: string;
    displayName: string;
    username: string | null;
    email: string | null;
    isPrimary: boolean;
    lastActiveAt: string | null;
  }>;
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

export interface TrackedRepositorySummary {
  workspace: string;
  slug: string;
  fullName: string;
  project: string | null;
  commits30d: number;
  contributors30d: number;
  // 30-day non-merge diff totals for the Repositories index's bar chart.
  // Reads zero before diff-stat ingest lands (transient).
  additions30d: number;
  deletions30d: number;
  lastCommitAt: string | null;
  syncStatus: RepoSyncStatus;
  // Soft-retired. The Repositories page badges it so a retired repo's stale
  // sync mark reads as "retired", not a live error.
  archived: boolean;
}

// Unified activity feed payload, discriminated by `kind`. `occurredAt` is
// commits.authored_at for commits and pull_requests.bitbucket_updated_at for
// PRs — so a PR row resurfaces on each state transition or comment churn.

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
  // True when the orchestrator gave up fetching diffs (typically HTTP 555 —
  // BB compute timeout). additions/deletions/filesChanged are then all 0
  // (stamp-with-zeros, which drops the commit from backfill pickup), so
  // renderers MUST branch on this flag, not on a "values are zero" heuristic,
  // to swap the +/-/files row for the exclamation icon.
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
  // Bands keyed per entity (a merged person's aliases collapse into one).
  contributors: Array<{ entityKind: 'user' | 'person'; entityId: number; displayName: string; commits: number }>;
}

// Activity actor filter. A 'user' matches one users.id; a 'person' expands
// server-side to every attached alias. Mirror of ActivityActor in
// apps/backend/src/dashboard/stats-store.ts.
export type ActivityActor = { kind: 'user' | 'person'; id: number };

export interface ActivityQuery {
  actor?: ActivityActor;
  repo?: string; // "<workspace>/<slug>"
  project?: string;
  before?: string; // ISO 8601 — cursor / range upper bound (exclusive)
  after?: string; // ISO 8601 — range lower bound (inclusive)
  hashPrefix?: string; // 1–40 hex chars; suppresses PRs server-side
  message?: string; // 2–200 chars; FTS on commits, ILIKE on PR titles
  limit?: number; // default 50, max 200
  // Activity page only — the embedded feed uses `before` as a cursor instead.
  offset?: number;
}

// Shared query-string builder for /api/activity + /api/activity-count, so the
// two callers can't drift on which params they include.
function encodeActivityQuery(query: ActivityQuery): string {
  const params = new URLSearchParams();
  if (query.actor !== undefined) {
    params.set('actor', String(query.actor.id));
    // Omit actorKind for 'user' to keep the common URL compact and
    // backward-compatible (?actor=5); only emit it for persons.
    if (query.actor.kind === 'person') params.set('actorKind', 'person');
  }
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
  bitbucketAuthState: () => request<{ state: 'ok' | 'unauthorized' }>('/api/bitbucket/auth-state'),
  latestCommit: (workspace: string, slug: string) =>
    request<LatestCommit>(
      `/api/stats/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/latest-commit`,
    ),
  topContributors: (window: ContributorWindow = '7d') =>
    request<TopContributorEntity[]>(`/api/stats/top-contributors?window=${window}`),
  userSummary: (userId: number) => request<UserSummary>(`/api/stats/users/${userId}/summary`),
  personSummary: (personId: number) => request<PersonSummary>(`/api/stats/people/${personId}/summary`),
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
  activityDaily: (query: { actor?: ActivityActor; repo?: string; project?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.actor !== undefined) {
      params.set('actor', String(query.actor.id));
      if (query.actor.kind === 'person') params.set('actorKind', 'person');
    }
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

// Live updates (SSE at /api/live). Mirror of the payloads the backend
// publishes — see apps/backend/src/events/bus.ts, must stay in lockstep.
// Wrapped in the typed LiveEventMap consumed by `lib/live.ts`.

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

export interface BitbucketAuthStatePayload {
  state: 'ok' | 'unauthorized';
}

// Person-layer mutation events. Mirror of the backend payloads in
// apps/backend/src/events/bus.ts.
export interface PersonCreatedPayload {
  personId: number;
  primaryUserId: number | null;
}
export interface PersonUpdatedPayload {
  personId: number;
}
export interface PersonAttachedPayload {
  personId: number;
  userId: number;
  becamePrimary: boolean;
}
export interface PersonDetachedPayload {
  personId: number;
  userId: number;
  wasPrimary: boolean;
}
export interface PersonPrimaryChangedPayload {
  personId: number;
  previousPrimaryUserId: number | null;
  newPrimaryUserId: number;
}
export interface PersonDissolvedPayload {
  personId: number;
  detachedUserIds: number[];
}

// event-name → payload shape, for type-safe handler registration in lib/live.ts.
export interface LiveEventMap {
  'tick.commits.complete': TickCommitsCompletePayload;
  'tick.prs.complete': TickPrsCompletePayload;
  'repository.sync-excluded': RepositoryExcludedPayload;
  'repository.included': RepositoryIncludedPayload;
  'repository.deleted': RepositoryDeletedPayload;
  'bitbucket.auth-state': BitbucketAuthStatePayload;
  'person.created': PersonCreatedPayload;
  'person.updated': PersonUpdatedPayload;
  'person.attached': PersonAttachedPayload;
  'person.detached': PersonDetachedPayload;
  'person.primary-changed': PersonPrimaryChangedPayload;
  'person.dissolved': PersonDissolvedPayload;
}

export type LiveEventName = keyof LiveEventMap;
