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

// Phase 5 — the Dashboard org-wide Top Contributors panel row, keyed on
// the merged entity (person or unattached user). Mirror of
// TopContributorEntity in apps/backend/src/dashboard/stats-store.ts.
// Carries a 30-day commit sparkline + window-scoped adds/dels and the
// ShipShow Score signals the Dashboard sorts + renders by. The per-repo /
// per-project lists use the trimmed RepoContributorEntity variant.
export interface TopContributorEntity {
  entityKind: 'user' | 'person';
  entityId: number;
  // Primary-first attached user_ids (length 1 for user rows). The
  // Dashboard activity-filter dropdown filters by attachedUserIds[0]
  // since the activity feed is single-actor — persons resolve to their
  // primary alias until multi-actor filtering lands.
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
    // Phase 5 alias merge — non-null when this user is attached to a
    // person. The user detail page renders a "Part of: <displayName>"
    // banner linking to /people/:id. Null when unattached.
    person: { id: number; displayName: string } | null;
  };
  // Phase 5 — sibling aliases merged into the same person (this account
  // excluded). Empty for an unattached user. Same shape as
  // PersonSummary.attachedUsers; drives the "Linked accounts" table.
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
    // Phase 5: distinct contributors over 30d, person-aware (a merged
    // person's aliases collapse to one).
    contributorCount30d: number;
    repositoryCount: number;
  };
  dailyCommits: Array<{ date: string; commits: number }>;
  // Project-scoped contributor table — Phase 5 person-aware, same
  // entity-keyed shape as the repo detail page's contributors so both
  // pages reuse the same row layout + merged-name pattern.
  topContributors: RepoContributorEntity[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
    // Phase 5: per-repo distinct contributors, person-aware.
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
// 'empty' = benign exclusion (empty on BitBucket, nothing to sync); distinct
// from 'excluded' (rename / force-push — needs an admin fix) so the
// Repositories page doesn't flag empty repos as problems.
export type RepoSyncStatus = 'ok' | 'error' | 'never' | 'excluded' | 'empty';

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
  // Phase 5: contributors are keyed on the merged ENTITY (person or
  // unattached user) — a person's aliases that both touched this repo
  // collapse into one row, so the count + list are person-aware. Sparkline
  // `last30Days` is repo-scoped (this entity's commits in this repo,
  // day-by-day over the trailing 30 days). Diff-stat fields are 30-day,
  // exclude merges, read zero when no diff-stat fetch has landed yet.
  contributors: RepoContributorEntity[];
}

// Phase 5 — mirror of RepoContributorEntity in the backend stats-store.
// Repo-detail contributor row keyed on the merged entity; the ×N pill +
// person/user link follow the dashboard Top Contributors pattern.
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
// apps/backend/src/scoring/badge.ts. Keep all three in lockstep when
// adding / removing badges. Display labels for these slugs live in
// the BadgeIcon component.
export type UserBadge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

// Within-persona tier. Today only `steady_eddie` carries one; the
// frontend renders it as a colored ring around the badge icon.
export type UserBadgeTier = 'bronze' | 'silver' | 'gold';

// One row on the /members leaderboard. Mirror of WorkspaceMember in
// apps/backend/src/dashboard/stats-store.ts — keep in lockstep.
// Phase 5: each row is either an unattached user or a merged person,
// discriminated by `entityKind`. `email` is the git-author email
// parsed from commits.author.raw on ingest — best-effort, not a
// verified workspace email. See the comment on users.email in
// schema.ts for caveats.
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
  // The user_ids behind this row, primary-first. Length 1 for user
  // rows; ≥1 for person rows. Drives the "merged from N accounts" pill
  // and lets SSE handlers know which per-user caches to drop.
  attachedUserIds: number[];
  // Search-only — every attached alias's name / username / email
  // concatenated, so a merged person is findable by any linked account.
  // A Fuse key on the Members table + ActorPicker; never rendered.
  aliasSearch: string;
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
  // ShipShow Score columns (docs/scoring.md). Sourced from the
  // leaderboard_entries view (user_score for user rows, person_score
  // for person rows) — null when the row isn't written yet (between
  // member sync and the next commits-sync tick). The table sorts by
  // scoreTrending DESC by default.
  scoreTrending: number | null;
  consistency90d: number | null;
  badge: UserBadge | null;
  // Within-persona tier (only steady_eddie carries one today). Drives
  // the colored ring around the badge icon.
  badgeTier: UserBadgeTier | null;
  isDormant: boolean;
}

// Phase 5 — the Person detail page payload. Mirror of PersonSummary
// in apps/backend/src/dashboard/stats-store.ts. Same shape as
// UserSummary plus the `attachedUsers` roster of underlying aliases.
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
  // 30-day non-merge diff totals. Surfaced for the Repositories
  // index's compound bar chart; reads zero on repos whose diff-stat
  // ingest hasn't landed yet (transient).
  additions30d: number;
  deletions30d: number;
  lastCommitAt: string | null;
  syncStatus: RepoSyncStatus;
  // True when the repo is soft-retired (archived). The Repositories page
  // badges it so a retired repo's stale sync mark reads as "retired",
  // not as a live error.
  archived: boolean;
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
  // Phase 5 — bands keyed per entity (a merged person's aliases collapse
  // into one band). The sunburst renders displayName + commits only.
  contributors: Array<{ entityKind: 'user' | 'person'; entityId: number; displayName: string; commits: number }>;
}

// Phase 5 — the activity actor filter. A 'user' matches one users.id;
// a 'person' expands server-side to every alias attached to the person.
// Mirror of ActivityActor in apps/backend/src/dashboard/stats-store.ts.
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
  // Offset-based pagination (Activity page only). Embedded feed leaves
  // this undefined and uses `before` as a cursor instead.
  offset?: number;
}

// Shared query-string builder for /api/activity + /api/activity-count.
// Same field set, same URL encoding — extracted so the two callers
// can't drift on which params they include.
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

export interface BitbucketAuthStatePayload {
  state: 'ok' | 'unauthorized';
}

// Phase 5 — person-layer mutation events. Mirror of the backend
// payloads in apps/backend/src/events/bus.ts. The Members store
// re-fetches the leaderboard on any of these; per-user-summary
// stores drop the affected aliases' cached entries.
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

// Map from event-name → payload shape. `lib/live.ts` uses this for
// type-safe handler registration (`bus.on('tick.commits.complete', p => ...)`).
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
