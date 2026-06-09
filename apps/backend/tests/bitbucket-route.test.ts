import { describe, it, expect, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { bitbucketAuthStateCache } from '../src/cache/redis.js';
import type { CacheClient } from '../src/cache/redis.js';
import type { AppConfig } from '../src/config.js';

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
};

// Minimum CacheClient surface the route actually uses — just GET against
// the auth-state key. The full ioredis interface is huge; the
// `as unknown as CacheClient` cast lets the test stub stay tiny without
// reaching for vi.mock.
function makeFakeRedis(initial: { authState?: 'ok' | 'unauthorized'; throwOnGet?: boolean } = {}): CacheClient {
  let value = initial.authState === 'unauthorized' ? 'unauthorized' : null;
  return {
    async get(key: string) {
      if (initial.throwOnGet) throw new Error('redis down');
      return key === bitbucketAuthStateCache.key ? value : null;
    },
    async set(key: string, v: string) {
      if (key === bitbucketAuthStateCache.key) value = v;
      return 'OK' as const;
    },
    async del(key: string) {
      if (key === bitbucketAuthStateCache.key) value = null;
      return 1;
    },
  } as unknown as CacheClient;
}

describe('GET /api/bitbucket/auth-state', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it("returns { state: 'ok' } when no Redis is wired", async () => {
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test') });
    const res = await appInstance.inject({ method: 'GET', url: '/api/bitbucket/auth-state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'ok' });
  });

  it("returns 'ok' when the Redis key is absent", async () => {
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test'), redis: makeFakeRedis() });
    const res = await appInstance.inject({ method: 'GET', url: '/api/bitbucket/auth-state' });
    expect(res.json()).toEqual({ state: 'ok' });
  });

  it("returns 'unauthorized' when the Redis key is set", async () => {
    appInstance = await buildApp({
      config: testConfig,
      logger: createLogger('test'),
      redis: makeFakeRedis({ authState: 'unauthorized' }),
    });
    const res = await appInstance.inject({ method: 'GET', url: '/api/bitbucket/auth-state' });
    expect(res.json()).toEqual({ state: 'unauthorized' });
  });

  it("falls back to 'ok' when Redis throws (infrastructure blip)", async () => {
    appInstance = await buildApp({
      config: testConfig,
      logger: createLogger('test'),
      redis: makeFakeRedis({ throwOnGet: true }),
    });
    const res = await appInstance.inject({ method: 'GET', url: '/api/bitbucket/auth-state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'ok' });
  });
});
