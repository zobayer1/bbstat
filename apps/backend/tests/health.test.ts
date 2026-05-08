import { describe, it, expect, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import type { AppConfig } from '../src/config.js';

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

describe('health routes', () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (appInstance) await appInstance.close();
    appInstance = undefined;
  });

  it('GET /healthz returns ok', async () => {
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test') });
    const res = await appInstance.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /readyz returns ready', async () => {
    appInstance = await buildApp({ config: testConfig, logger: createLogger('test') });
    const res = await appInstance.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});
