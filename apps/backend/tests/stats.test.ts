import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import type { AppConfig } from '../src/config.js';
import type {
  ActivityEntry,
  ActivityFilters,
  LatestCommit,
  OverviewStats,
  ProjectStats,
  RepoActivity,
  StatsStore,
  TopContributorWithSparkline,
  UserSummary,
} from '../src/dashboard/stats-store.js';
import type { UserSummaryCache } from '../src/dashboard/user-summary-cache.js';

function makeCache(overrides: Partial<UserSummaryCache<UserSummary>> = {}): UserSummaryCache<UserSummary> {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    ...overrides,
  };
}

const testConfig: AppConfig = {
  NODE_ENV: 'test',
  BACKEND_HOST: 'localhost',
  BACKEND_PORT: 0,
  TLS_KEY_PATH: 'etc/tls/server.key',
  TLS_CERT_PATH: 'etc/tls/server.crt',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  BITBUCKET_BASE_URL: 'https://api.bitbucket.org/2.0',
  BITBUCKET_HOURLY_CALL_BUDGET: 800,
  BITBUCKET_MIN_CALL_INTERVAL_MS: 0,
  BITBUCKET_MAX_CALL_INTERVAL_MS: 0,
  SYNC_MEMBERS_CRON: '*/10 * * * *',
  SYNC_REPOS_CRON: '*/5 * * * *',
  SYNC_COMMITS_CRON: '*/15 * * * *',
  COMMITS_BACKFILL_MAX_PAGES: 5,
  COMMITS_BACKFILL_SINCE: '',
  COMMIT_SYNC_CONCURRENCY: 3,
  COMMIT_SYNC_BUDGET_THRESHOLD: 20,
  DIFF_STATS_MAX_PER_REPO_PER_TICK: 50,
  DIFF_STATS_BUDGET_THRESHOLD: 10,
  SYNC_PRS_CRON: '*/30 * * * *',
  PR_BACKFILL_MAX_PAGES: 5,
  PR_SYNC_CONCURRENCY: 3,
  PR_SYNC_BUDGET_THRESHOLD: 20,
  DEEPEN_BACKFILL_MAX_PAGES: 5,
  DEEPEN_BUDGET_THRESHOLD: 100,
};

function makeStatsStore(overrides: Partial<StatsStore> = {}): StatsStore {
  return {
    getOverview: vi.fn(),
    getLatestCommitForRepository: vi.fn(),
    getTopContributors: vi.fn(),
    getUserSummary: vi.fn(),
    getProjectStats: vi.fn(),
    getRepositoryActivity: vi.fn(),
    listTrackedRepositoriesWithStats: vi.fn(),
    getActivity: vi.fn(),
    ...overrides,
  };
}

describe('GET /api/stats/overview', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the overview from the injected store', async () => {
    const overview: OverviewStats = {
      users: 49,
      repositories: 3,
      projects: 1,
      totalCommits: 1234,
      commitsLast7Days: 87,
      commitsLast30Days: 312,
    };
    const statsStore = makeStatsStore({ getOverview: vi.fn().mockResolvedValue(overview) });

    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });
    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/overview' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(overview);
    expect(statsStore.getOverview).toHaveBeenCalledOnce();
  });

  it('returns 404 when statsStore is not registered', async () => {
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test') });
    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/overview' });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/stats/repositories/:workspace/:slug/latest-commit', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the latest commit when present', async () => {
    const commit: LatestCommit = {
      sha: 'a1b2c3',
      message: 'feat: add thing',
      authoredAt: '2026-05-08T12:00:00.000Z',
      authorDisplayName: 'Alice',
      authorBitbucketUuid: '{u1}',
    };
    const statsStore = makeStatsStore({
      getLatestCommitForRepository: vi.fn().mockResolvedValue(commit),
    });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/stats/repositories/tigerit/boing-server/latest-commit',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(commit);
    expect(statsStore.getLatestCommitForRepository).toHaveBeenCalledWith('tigerit', 'boing-server');
  });

  it('returns 404 when no commit (untracked or empty repo)', async () => {
    const statsStore = makeStatsStore({
      getLatestCommitForRepository: vi.fn().mockResolvedValue(null),
    });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/stats/repositories/tigerit/never-tracked/latest-commit',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', fullName: 'tigerit/never-tracked' });
  });
});

describe('GET /api/stats/top-contributors', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('defaults to a 7-day window when no query param is given', async () => {
    const contributors: TopContributorWithSparkline[] = [
      {
        userId: 1,
        bitbucketUuid: '{u1}',
        displayName: 'Alice',
        commits: 42,
        last30Days: Array.from({ length: 30 }, (_, i) => (i === 29 ? 5 : 1)),
      },
      {
        userId: 2,
        bitbucketUuid: '{u2}',
        displayName: 'Bob',
        commits: 17,
        last30Days: new Array(30).fill(0),
      },
    ];
    const getTopContributors = vi.fn().mockResolvedValue(contributors);
    const statsStore = makeStatsStore({ getTopContributors });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/top-contributors' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(contributors);
    expect(getTopContributors).toHaveBeenCalledWith(7);
  });

  it('forwards a 30-day window when window=30d', async () => {
    const getTopContributors = vi.fn().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getTopContributors });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/top-contributors?window=30d' });

    expect(res.statusCode).toBe(200);
    expect(getTopContributors).toHaveBeenCalledWith(30);
  });

  it('rejects invalid window with 400', async () => {
    const statsStore = makeStatsStore();
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/top-contributors?window=99y' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_window', allowed: ['7d', '30d'] });
    expect(statsStore.getTopContributors).not.toHaveBeenCalled();
  });
});

const sampleUserSummary: UserSummary = {
  user: { id: 7, bitbucketUuid: '{u7}', displayName: 'Alice' },
  totals: {
    commits7d: 12,
    commits30d: 40,
    commitsAllTime: 200,
    additions7d: 0,
    deletions7d: 0,
    additions30d: 0,
    deletions30d: 0,
    repositoriesAllTime: 4,
  },
  dailyCommits: [{ date: '2026-05-12', commits: 3 }],
  topRepos: [
    { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1', project: 'COMM', commits: 8, syncStatus: 'ok' },
  ],
};

describe('GET /api/stats/users/:userId/summary', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the summary from the store on cache miss and writes through', async () => {
    const getUserSummary = vi.fn().mockResolvedValue(sampleUserSummary);
    const statsStore = makeStatsStore({ getUserSummary });
    const cache = makeCache();
    appInstance = await buildApp({
      config: testConfig,
      logger: createLogger('test'),
      statsStore,
      userSummaryCache: cache,
    });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/users/7/summary' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sampleUserSummary);
    expect(cache.get).toHaveBeenCalledWith(7);
    expect(getUserSummary).toHaveBeenCalledWith(7);
    expect(cache.set).toHaveBeenCalledWith(7, sampleUserSummary);
  });

  it('returns the cached value without calling the store on a cache hit', async () => {
    const getUserSummary = vi.fn();
    const statsStore = makeStatsStore({ getUserSummary });
    const cache = makeCache({ get: vi.fn(async () => sampleUserSummary) });
    appInstance = await buildApp({
      config: testConfig,
      logger: createLogger('test'),
      statsStore,
      userSummaryCache: cache,
    });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/users/7/summary' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sampleUserSummary);
    expect(getUserSummary).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns 404 when the store reports the user does not exist', async () => {
    const getUserSummary = vi.fn().mockResolvedValue(null);
    const statsStore = makeStatsStore({ getUserSummary });
    const cache = makeCache();
    appInstance = await buildApp({
      config: testConfig,
      logger: createLogger('test'),
      statsStore,
      userSummaryCache: cache,
    });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/users/999/summary' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', userId: 999 });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns 400 when userId is not a positive integer', async () => {
    const statsStore = makeStatsStore();
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/users/-3/summary' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_user_id' });
    expect(statsStore.getUserSummary).not.toHaveBeenCalled();
  });
});

describe('GET /api/stats/projects/:projectKey', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the project stats from the store', async () => {
    const project: ProjectStats = {
      project: 'COMM',
      totals: { commits7d: 1, commits30d: 2, contributorCount7d: 3, repositoryCount: 4 },
      weeklyCommits: [{ weekStart: '2026-05-04', commits: 5 }],
      dailyCommits: [{ date: '2026-05-12', commits: 2 }],
      topContributors: [{ userId: 1, bitbucketUuid: '{u1}', displayName: 'Alice', commits: 9 }],
      repositories: [
        {
          workspace: 'tigerit',
          slug: 'r1',
          fullName: 'tigerit/r1',
          commits30d: 7,
          contributors30d: 2,
          lastCommitAt: '2026-05-12T00:00:00.000Z',
          syncStatus: 'ok',
        },
      ],
    };
    const getProjectStats = vi.fn().mockResolvedValue(project);
    const statsStore = makeStatsStore({ getProjectStats });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/projects/COMM' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(project);
    expect(getProjectStats).toHaveBeenCalledWith('COMM');
  });

  it('returns 404 for unknown project keys', async () => {
    const statsStore = makeStatsStore({ getProjectStats: vi.fn().mockResolvedValue(null) });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/projects/UNKNOWN' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', projectKey: 'UNKNOWN' });
  });
});

describe('GET /api/stats/repositories/:workspace/:slug/activity', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the repo activity from the store', async () => {
    const activity: RepoActivity = {
      repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1', syncStatus: 'ok' },
      dailyCommits: [{ date: '2026-05-12', commits: 4, additions: 0, deletions: 0 }],
      contributors: [{ userId: 1, bitbucketUuid: '{u1}', displayName: 'Alice', commits: 4, last30Days: [0, 1, 0, 3] }],
    };
    const getRepositoryActivity = vi.fn().mockResolvedValue(activity);
    const statsStore = makeStatsStore({ getRepositoryActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/stats/repositories/tigerit/r1/activity',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(activity);
    expect(getRepositoryActivity).toHaveBeenCalledWith('tigerit', 'r1');
  });

  it('returns 404 for untracked repos', async () => {
    const statsStore = makeStatsStore({ getRepositoryActivity: vi.fn().mockResolvedValue(null) });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/stats/repositories/tigerit/never-tracked/activity',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', fullName: 'tigerit/never-tracked' });
  });
});

describe('GET /api/stats/repositories', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the tracked-repository list from the store', async () => {
    const repos = [
      {
        workspace: 'tigerit',
        slug: 'r1',
        fullName: 'tigerit/r1',
        project: 'COMM',
        commits30d: 30,
        contributors30d: 4,
        lastCommitAt: '2026-05-12T00:00:00.000Z',
        syncStatus: 'ok' as const,
      },
      {
        workspace: 'tigerit',
        slug: 'orphan',
        fullName: 'tigerit/orphan',
        project: null,
        commits30d: 0,
        contributors30d: 0,
        lastCommitAt: null,
        syncStatus: 'never' as const,
      },
    ];
    const listTrackedRepositoriesWithStats = vi.fn().mockResolvedValue(repos);
    const statsStore = makeStatsStore({ listTrackedRepositoriesWithStats });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/repositories' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(repos);
    expect(listTrackedRepositoriesWithStats).toHaveBeenCalledTimes(1);
  });
});

const sampleActivity: ActivityEntry[] = [
  {
    kind: 'pr',
    prId: 42,
    title: 'feat: shiny',
    state: 'OPEN',
    sourceBranch: 'feat',
    destinationBranch: 'main',
    repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
    author: { userId: 1, displayName: 'Alice', bitbucketUuid: '{u1}' },
    occurredAt: '2026-05-12T18:00:00.000Z',
  },
  {
    kind: 'commit',
    sha: 'a1b2c3',
    message: 'feat: thing',
    additions: 12,
    deletions: 3,
    repository: { workspace: 'tigerit', slug: 'r1', fullName: 'tigerit/r1' },
    author: null,
    occurredAt: '2026-05-12T14:00:00.000Z',
  },
];

describe('GET /api/activity', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the unified feed with no filters and default limit=50', async () => {
    const getActivity = vi.fn<(f: ActivityFilters) => Promise<ActivityEntry[]>>().mockResolvedValue(sampleActivity);
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sampleActivity);
    expect(getActivity).toHaveBeenCalledWith({
      actor: null,
      repo: null,
      project: null,
      before: null,
      limit: 50,
    });
  });

  it('parses every filter axis and forwards as ActivityFilters', async () => {
    const getActivity = vi.fn<(f: ActivityFilters) => Promise<ActivityEntry[]>>().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/activity?actor=7&repo=tigerit/boing-server&project=COMM&before=2026-05-12T18:00:00.000Z&limit=25',
    });

    expect(res.statusCode).toBe(200);
    expect(getActivity).toHaveBeenCalledWith({
      actor: 7,
      repo: { workspace: 'tigerit', slug: 'boing-server' },
      project: 'COMM',
      before: new Date('2026-05-12T18:00:00.000Z'),
      limit: 25,
    });
  });

  it('rejects malformed `repo` with 400 (missing slug)', async () => {
    const getActivity = vi.fn();
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?repo=tigerit' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    expect(getActivity).not.toHaveBeenCalled();
  });

  it('rejects malformed `before` with 400', async () => {
    const getActivity = vi.fn();
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?before=not-a-date' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    expect(getActivity).not.toHaveBeenCalled();
  });

  it('rejects limit above 200 with 400 (cursor-pagination bounds)', async () => {
    const getActivity = vi.fn();
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?limit=500' });

    expect(res.statusCode).toBe(400);
    expect(getActivity).not.toHaveBeenCalled();
  });
});
