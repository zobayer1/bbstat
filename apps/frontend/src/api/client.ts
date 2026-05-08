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

export const api = {
  health: () => request<{ status: string; uptime: number }>('/healthz'),
  statsOverview: () => request<OverviewStats>('/api/stats/overview'),
  latestCommit: (workspace: string, slug: string) =>
    request<LatestCommit>(
      `/api/stats/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/latest-commit`,
    ),
  topContributors: (window: ContributorWindow = '7d') =>
    request<TopContributor[]>(`/api/stats/top-contributors?window=${window}`),
};
