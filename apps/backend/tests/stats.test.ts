import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import type { AppConfig } from '../src/config.js';
import type { OverviewStats, StatsStore } from '../src/dashboard/stats-store.js';

const testConfig: AppConfig = {
  NODE_ENV: 'test',
  BACKEND_HOST: 'localhost',
  BACKEND_PORT: 0,
  TLS_KEY_PATH: 'etc/tls/server.key',
  TLS_CERT_PATH: 'etc/tls/server.crt',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  BITBUCKET_BASE_URL: 'https://api.bitbucket.org/2.0',
  SEED_TRACKED_REPOS: '',
  SYNC_MEMBERS_CRON: '*/10 * * * *',
  SYNC_REPOS_CRON: '*/5 * * * *',
};

describe('GET /api/stats/overview', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('returns the overview from the injected store', async () => {
    const overview: OverviewStats = { users: 49, repositories: 3, projects: 1 };
    const statsStore: StatsStore = { getOverview: vi.fn().mockResolvedValue(overview) };

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
