import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import type { AppConfig } from '../src/config.js';
import type {
  ActivityEntry,
  ActivityFilters,
  LatestCommit,
  OverviewStats,
  PersonSummary,
  ProjectStats,
  RepoActivity,
  StatsStore,
  TopContributorEntity,
  UserSummary,
  WorkspaceMember,
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
  BACKEND_TLS: 'on',
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
  DIFF_STATS_BUDGET_THRESHOLD: 10,
  DIFF_STATS_BACKFILL_MAX_COMMITS_PER_TICK: 50,
  DIFF_STATS_BACKFILL_BUDGET_THRESHOLD: 20,
  SYNC_PRS_ENABLED: false,
  REPO_DISCOVERY_ENABLED: false,
  SYNC_PRS_CRON: '*/30 * * * *',
  PR_BACKFILL_MAX_PAGES: 5,
  PR_SYNC_CONCURRENCY: 3,
  PR_SYNC_BUDGET_THRESHOLD: 20,
  DEEPEN_BACKFILL_MAX_PAGES: 5,
  DEEPEN_BUDGET_THRESHOLD: 100,
  SYNC_BACKOFF_SLOPE_MIN_PER_QUIET_DAY: 4,
  SYNC_BACKOFF_MIN_INTERVAL_MIN: 5,
  SYNC_BACKOFF_MAX_INTERVAL_MIN: 1440,
  SYNC_MAX_COLD_REPOS_PER_TICK: 5,
  MCP_HOST: '127.0.0.1',
  MCP_PORT: 8090,
  IS_MERGE_BACKFILL_MAX_PAGES: 5,
  IS_MERGE_BACKFILL_BUDGET_THRESHOLD: 50,
  SYNC_EMPTY_GRACE_HOURS: 24,
};

function makeStatsStore(overrides: Partial<StatsStore> = {}): StatsStore {
  return {
    getOverview: vi.fn(),
    getLatestCommitForRepository: vi.fn(),
    getTopContributors: vi.fn(),
    getUserSummary: vi.fn(),
    getPersonSummary: vi.fn(),
    getProjectStats: vi.fn(),
    getRepositoryActivity: vi.fn(),
    listTrackedRepositoriesWithStats: vi.fn(),
    listWorkspaceMembers: vi.fn(),
    getActivity: vi.fn(),
    getActivityCount: vi.fn(),
    getActivityDaily: vi.fn(),
    getRepoContributorBreakdown: vi.fn(),
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
      contributors: 49,
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
    const contributors: TopContributorEntity[] = [
      {
        entityKind: 'user',
        entityId: 1,
        attachedUserIds: [1],
        bitbucketUuid: '{u1}',
        displayName: 'Alice',
        commits: 42,
        last30Days: Array.from({ length: 30 }, (_, i) => (i === 29 ? 5 : 1)),
        additionsWindow: 1200,
        deletionsWindow: 400,
        reposWindow: 4,
        momentum: 142.7,
        consistency90d: 0.42,
      },
      {
        entityKind: 'person',
        entityId: 9,
        attachedUserIds: [2, 7],
        bitbucketUuid: '{u2}',
        displayName: 'Bob (merged)',
        commits: 17,
        last30Days: new Array(30).fill(0),
        additionsWindow: 500,
        deletionsWindow: 150,
        reposWindow: 2,
        momentum: 38.4,
        consistency90d: 0.31,
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

describe('GET /api/stats/members', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  const sampleMembers: WorkspaceMember[] = [
    {
      entityKind: 'user',
      entityId: 1,
      bitbucketUuid: '{u1}',
      displayName: 'Alice',
      username: 'alice',
      email: 'alice@example.com',
      isWorkspaceMember: true,
      attachedUserIds: [1],
      aliasSearch: 'Alice alice alice@example.com',
      commits7d: 12,
      repos7d: 3,
      commits30d: 45,
      repos30d: 5,
      commitsAllTime: 200,
      reposAllTime: 7,
      lastActiveAt: '2026-05-15T10:00:00.000Z',
      last30Days: Array.from({ length: 30 }, (_, i) => (i === 29 ? 4 : 0)),
      scoreTrending: 142.7,
      consistency90d: 0.42,
      badge: 'steady_eddie',
      badgeTier: 'gold',
      isDormant: false,
    },
    {
      entityKind: 'person',
      entityId: 9,
      bitbucketUuid: '{u2}',
      displayName: 'Bob',
      username: null,
      email: null,
      isWorkspaceMember: false,
      attachedUserIds: [2, 7],
      aliasSearch: 'Bob bob bob@example.com Carol carol carol@example.com',
      commits7d: 0,
      repos7d: 0,
      commits30d: 0,
      repos30d: 0,
      commitsAllTime: 18,
      reposAllTime: 2,
      lastActiveAt: '2026-04-02T08:00:00.000Z',
      last30Days: new Array(30).fill(0),
      scoreTrending: 0,
      consistency90d: null,
      badge: null,
      badgeTier: null,
      isDormant: true,
    },
  ];

  it('returns the full members payload (no window query param)', async () => {
    const listWorkspaceMembers = vi.fn().mockResolvedValue(sampleMembers);
    const statsStore = makeStatsStore({ listWorkspaceMembers });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/members' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sampleMembers);
    expect(listWorkspaceMembers).toHaveBeenCalledWith();
  });

  it("ignores a ?window= query param (legacy clients shouldn't 400)", async () => {
    // Pre-V1_18 clients still send ?window=7d / ?window=30d / etc. The
    // route used to map those to a windowDays argument; now it ignores
    // them so a stale frontend cache doesn\'t cause a hard 400 during
    // the rolling deploy. Backwards compatibility is cheap here —
    // listWorkspaceMembers takes no arguments anyway.
    const listWorkspaceMembers = vi.fn().mockResolvedValue([]);
    const statsStore = makeStatsStore({ listWorkspaceMembers });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/members?window=30d' });

    expect(res.statusCode).toBe(200);
    expect(listWorkspaceMembers).toHaveBeenCalledWith();
  });
});

const sampleUserSummary: UserSummary = {
  user: {
    id: 7,
    bitbucketUuid: '{u7}',
    displayName: 'Alice',
    email: 'alice@example.com',
    badge: 'steady_eddie',
    badgeTier: 'gold',
    person: null,
  },
  linkedAccounts: [],
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
    {
      workspace: 'tigerit',
      slug: 'r1',
      fullName: 'tigerit/r1',
      project: 'COMM',
      commits: 8,
      syncStatus: 'ok',
      additions30d: 0,
      deletions30d: 0,
    },
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

describe('GET /api/stats/people/:personId/summary', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  const samplePersonSummary: PersonSummary = {
    person: {
      id: 3,
      displayName: 'Jane Doe',
      bitbucketUuid: '{u4}',
      email: 'jane.work@example.com',
      badge: 'steady_eddie',
      badgeTier: 'silver',
    },
    attachedUsers: [
      {
        id: 4,
        bitbucketUuid: '{u4}',
        displayName: 'jane.work',
        username: 'janew',
        email: 'jane.work@example.com',
        isPrimary: true,
        lastActiveAt: '2026-05-20T10:00:00.000Z',
      },
      {
        id: 5,
        bitbucketUuid: '{u5}',
        displayName: 'janedoe93',
        username: null,
        email: 'jane@personal.com',
        isPrimary: false,
        lastActiveAt: '2026-03-11T08:00:00.000Z',
      },
    ],
    totals: {
      commits7d: 4,
      commits30d: 20,
      commitsAllTime: 300,
      additions7d: 100,
      deletions7d: 30,
      additions30d: 800,
      deletions30d: 250,
      repositoriesAllTime: 12,
    },
    dailyCommits: [{ date: '2026-05-20', commits: 3 }],
    topRepos: [],
  };

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the person summary from the store (uncached)', async () => {
    const getPersonSummary = vi.fn().mockResolvedValue(samplePersonSummary);
    const statsStore = makeStatsStore({ getPersonSummary });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/people/3/summary' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(samplePersonSummary);
    expect(getPersonSummary).toHaveBeenCalledWith(3);
  });

  it('returns 404 when the person does not exist', async () => {
    const getPersonSummary = vi.fn().mockResolvedValue(null);
    const statsStore = makeStatsStore({ getPersonSummary });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/people/99/summary' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', personId: 99 });
  });

  it('returns 400 when personId is not a positive integer', async () => {
    const statsStore = makeStatsStore();
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/people/0/summary' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_person_id' });
    expect(statsStore.getPersonSummary).not.toHaveBeenCalled();
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
      totals: { commits7d: 1, commits30d: 2, contributorCount30d: 3, repositoryCount: 4 },
      dailyCommits: [{ date: '2026-05-12', commits: 2 }],
      topContributors: [
        {
          entityKind: 'user',
          entityId: 1,
          attachedUserIds: [1],
          bitbucketUuid: '{u1}',
          displayName: 'Alice',
          commits: 9,
          last30Days: new Array(30).fill(0),
          additions30d: 120,
          deletions30d: 45,
        },
      ],
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
      repository: {
        workspace: 'tigerit',
        slug: 'r1',
        fullName: 'tigerit/r1',
        project: 'COMM',
        syncStatus: 'ok',
      },
      dailyCommits: [{ date: '2026-05-12', commits: 4, additions: 0, deletions: 0 }],
      diffStats: { additions7d: 0, deletions7d: 0, additions30d: 0, deletions30d: 0 },
      contributors: [
        {
          entityKind: 'user',
          entityId: 1,
          attachedUserIds: [1],
          bitbucketUuid: '{u1}',
          displayName: 'Alice',
          commits: 4,
          last30Days: [0, 1, 0, 3],
          additions30d: 0,
          deletions30d: 0,
        },
      ],
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
        additions30d: 1234,
        deletions30d: 432,
        lastCommitAt: '2026-05-12T00:00:00.000Z',
        syncStatus: 'ok' as const,
        archived: false,
      },
      {
        workspace: 'tigerit',
        slug: 'orphan',
        fullName: 'tigerit/orphan',
        project: null,
        commits30d: 0,
        contributors30d: 0,
        additions30d: 0,
        deletions30d: 0,
        lastCommitAt: null,
        syncStatus: 'never' as const,
        archived: true,
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

describe('GET /api/stats/repo-contributors', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the per-repo contributor breakdown with default caps', async () => {
    const payload = [
      {
        workspace: 'tigerit',
        slug: 'r1',
        fullName: 'tigerit/r1',
        project: 'COMM',
        commits: 50,
        contributors: [{ userId: 1, displayName: 'Alice', commits: 30 }],
      },
    ];
    const getRepoContributorBreakdown = vi.fn().mockResolvedValue(payload);
    const statsStore = makeStatsStore({ getRepoContributorBreakdown });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/repo-contributors' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(payload);
    expect(getRepoContributorBreakdown).toHaveBeenCalledWith({
      windowDays: 30,
      topRepos: 15,
      topPerRepo: 5,
      project: null,
    });
  });

  it('passes overrides through to the store', async () => {
    const getRepoContributorBreakdown = vi.fn().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getRepoContributorBreakdown });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/stats/repo-contributors?windowDays=90&topRepos=20&topPerRepo=10&project=COMM',
    });

    expect(res.statusCode).toBe(200);
    expect(getRepoContributorBreakdown).toHaveBeenCalledWith({
      windowDays: 90,
      topRepos: 20,
      topPerRepo: 10,
      project: 'COMM',
    });
  });

  it('rejects out-of-range caps with 400', async () => {
    const getRepoContributorBreakdown = vi.fn();
    const statsStore = makeStatsStore({ getRepoContributorBreakdown });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/stats/repo-contributors?topRepos=999' });

    expect(res.statusCode).toBe(400);
    expect(getRepoContributorBreakdown).not.toHaveBeenCalled();
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
    filesChanged: 4,
    isMerge: false,
    diffStatsUnavailable: false,
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
      after: null,
      hashPrefix: null,
      message: null,
      limit: 50,
      offset: 0,
    });
  });

  it('parses every filter axis and forwards as ActivityFilters', async () => {
    const getActivity = vi.fn<(f: ActivityFilters) => Promise<ActivityEntry[]>>().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/activity?actor=7&repo=tigerit/boing-server&project=COMM&before=2026-05-12T18:00:00.000Z&after=2026-05-01T00:00:00.000Z&hashPrefix=abc123&message=widget&limit=25&offset=200',
    });

    expect(res.statusCode).toBe(200);
    expect(getActivity).toHaveBeenCalledWith({
      actor: { kind: 'user', id: 7 },
      repo: { workspace: 'tigerit', slug: 'boing-server' },
      project: 'COMM',
      before: new Date('2026-05-12T18:00:00.000Z'),
      after: new Date('2026-05-01T00:00:00.000Z'),
      hashPrefix: 'abc123',
      message: 'widget',
      limit: 25,
      offset: 200,
    });
  });

  it('maps actorKind=person to a person actor (expands to aliases in the store)', async () => {
    const getActivity = vi.fn<(f: ActivityFilters) => Promise<ActivityEntry[]>>().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?actor=3&actorKind=person' });

    expect(res.statusCode).toBe(200);
    expect(getActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: 'person', id: 3 } }));
  });

  it('defaults actorKind to user when actor is given without a kind (legacy clients)', async () => {
    const getActivity = vi.fn<(f: ActivityFilters) => Promise<ActivityEntry[]>>().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?actor=5' });

    expect(res.statusCode).toBe(200);
    expect(getActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: 'user', id: 5 } }));
  });

  it('lowercases the hashPrefix before passing it to the store', async () => {
    const getActivity = vi.fn<(f: ActivityFilters) => Promise<ActivityEntry[]>>().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?hashPrefix=ABC123dEF' });

    expect(res.statusCode).toBe(200);
    expect(getActivity).toHaveBeenCalledWith(expect.objectContaining({ hashPrefix: 'abc123def' }));
  });

  it('rejects a non-hex hashPrefix with 400', async () => {
    const getActivity = vi.fn();
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?hashPrefix=zxy' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_query');
    expect(getActivity).not.toHaveBeenCalled();
  });

  it('rejects a too-short message with 400', async () => {
    const getActivity = vi.fn();
    const statsStore = makeStatsStore({ getActivity });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity?message=a' });

    expect(res.statusCode).toBe(400);
    expect(getActivity).not.toHaveBeenCalled();
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

describe('GET /api/activity-daily', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the daily aggregate with null filters when no query is provided', async () => {
    const payload = [{ date: '2026-05-10', commits: 4 }];
    const getActivityDaily = vi.fn().mockResolvedValue(payload);
    const statsStore = makeStatsStore({ getActivityDaily });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity-daily' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(payload);
    expect(getActivityDaily).toHaveBeenCalledWith({ actor: null, repo: null, project: null });
  });

  it('forwards actor / repo / project filters', async () => {
    const getActivityDaily = vi.fn().mockResolvedValue([]);
    const statsStore = makeStatsStore({ getActivityDaily });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/activity-daily?actor=7&repo=tigerit/boing-server&project=COMM',
    });

    expect(res.statusCode).toBe(200);
    expect(getActivityDaily).toHaveBeenCalledWith({
      actor: { kind: 'user', id: 7 },
      repo: { workspace: 'tigerit', slug: 'boing-server' },
      project: 'COMM',
    });
  });
});

describe('GET /api/activity-count', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns { total } with all filters null when none are provided', async () => {
    const getActivityCount = vi.fn().mockResolvedValue(42);
    const statsStore = makeStatsStore({ getActivityCount });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({ method: 'GET', url: '/api/activity-count' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 42 });
    expect(getActivityCount).toHaveBeenCalledWith({
      actor: null,
      repo: null,
      project: null,
      before: null,
      after: null,
      hashPrefix: null,
      message: null,
      limit: 50,
      offset: 0,
    });
  });

  it('forwards every filter axis to the store', async () => {
    const getActivityCount = vi.fn().mockResolvedValue(0);
    const statsStore = makeStatsStore({ getActivityCount });
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), statsStore });

    const res = await appInstance.inject({
      method: 'GET',
      url: '/api/activity-count?actor=7&repo=tigerit/r1&project=COMM&after=2026-05-01T00:00:00.000Z&message=widget',
    });

    expect(res.statusCode).toBe(200);
    expect(getActivityCount).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'user', id: 7 },
        repo: { workspace: 'tigerit', slug: 'r1' },
        project: 'COMM',
        after: new Date('2026-05-01T00:00:00.000Z'),
        message: 'widget',
      }),
    );
  });
});
