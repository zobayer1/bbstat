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
  users: number;
  repositories: number;
  projects: number;
  totalCommits: number;
  commitsLast7Days: number;
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

export type ContributorWindow = '7d' | '30d';

// Phase 3 per-entity rollup endpoints. Shapes mirror the StatsStore result
// types in apps/backend/src/dashboard/stats-store.ts — keep in lockstep.

export interface UserSummary {
  user: { id: number; bitbucketUuid: string; displayName: string };
  totals: {
    commits7d: number;
    commits30d: number;
    commitsAllTime: number;
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
  };
  dailyCommits: Array<{ date: string; commits: number }>;
  topRepos: Array<{ workspace: string; slug: string; fullName: string; project: string | null; commits: number }>;
}

export interface ProjectStats {
  project: string;
  totals: {
    commits7d: number;
    commits30d: number;
    contributorCount7d: number;
    repositoryCount: number;
  };
  weeklyCommits: Array<{ weekStart: string; commits: number }>;
  topContributors: TopContributor[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
    lastCommitAt: string | null;
  }>;
}

export interface RepoActivity {
  repository: { workspace: string; slug: string; fullName: string };
  dailyCommits: Array<{ date: string; commits: number; additions: number; deletions: number }>;
  recentCommits: LatestCommit[];
  contributors: TopContributor[];
}

export interface TrackedRepositorySummary {
  workspace: string;
  slug: string;
  fullName: string;
  project: string | null;
  commits30d: number;
  contributors30d: number;
  lastCommitAt: string | null;
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

export interface ActivityQuery {
  actor?: number;
  repo?: string; // "<workspace>/<slug>"
  project?: string;
  before?: string; // ISO 8601
  limit?: number; // default 50, max 200
}

export const api = {
  health: () => request<{ status: string; uptime: number }>('/healthz'),
  statsOverview: () => request<OverviewStats>('/api/stats/overview'),
  latestCommit: (workspace: string, slug: string) =>
    request<LatestCommit>(
      `/api/stats/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/latest-commit`,
    ),
  topContributors: (window: ContributorWindow = '7d') =>
    request<TopContributor[]>(`/api/stats/top-contributors?window=${window}`),
  userSummary: (userId: number) => request<UserSummary>(`/api/stats/users/${userId}/summary`),
  projectStats: (projectKey: string) => request<ProjectStats>(`/api/stats/projects/${encodeURIComponent(projectKey)}`),
  repositoryActivity: (workspace: string, slug: string) =>
    request<RepoActivity>(
      `/api/stats/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/activity`,
    ),
  listRepositories: () => request<TrackedRepositorySummary[]>('/api/stats/repositories'),
  activity: (query: ActivityQuery = {}) => {
    const params = new URLSearchParams();
    if (query.actor !== undefined) params.set('actor', String(query.actor));
    if (query.repo !== undefined) params.set('repo', query.repo);
    if (query.project !== undefined) params.set('project', query.project);
    if (query.before !== undefined) params.set('before', query.before);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const qs = params.toString();
    return request<ActivityEntry[]>(`/api/stats/activity${qs.length > 0 ? `?${qs}` : ''}`);
  },
};
