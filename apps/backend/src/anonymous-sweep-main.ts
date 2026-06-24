// Entry point for the standalone anonymous-commit sweep runner (`make
// dev-resync`). One-shot `runAnonymousSweep` loop instead of cron jobs;
// independent of the main sync. Exits cleanly when every anonymous commit
// got attributed (count = 0) or every repo with remaining anonymous commits
// is marked complete (the residual is structurally anonymous).

import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createDb } from './db/client.js';
import { BitbucketClient } from './bitbucket/client.js';
import { createDrizzleCommitStore } from './sync/commit-store.js';
import { createCache } from './cache/redis.js';
import { createDrizzleRollupStore } from './dashboard/rollup-store.js';
import { createRedisUserSummaryCache } from './dashboard/user-summary-cache.js';
import { runAnonymousSweep } from './sync/anonymous-sweep.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV).child({ name: 'bbstat-anonymous-sweep' });

  if (!config.BITBUCKET_AUTH_EMAIL || !config.BITBUCKET_AUTH_TOKEN || !config.BITBUCKET_WORKSPACE) {
    logger.warn('anonymous-sweep skipped: BITBUCKET_AUTH_EMAIL / BITBUCKET_AUTH_TOKEN / BITBUCKET_WORKSPACE not set');
    return;
  }

  const db = createDb(config.DATABASE_URL);
  const commitStore = createDrizzleCommitStore(db);
  const rollupStore = createDrizzleRollupStore(db);
  const redis = createCache(config.REDIS_URL);
  const userSummaryCache = createRedisUserSummaryCache(redis);
  const client = new BitbucketClient({
    baseUrl: config.BITBUCKET_BASE_URL,
    email: config.BITBUCKET_AUTH_EMAIL,
    token: config.BITBUCKET_AUTH_TOKEN,
    hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
    minCallIntervalMs: config.BITBUCKET_MIN_CALL_INTERVAL_MS,
    maxCallIntervalMs: config.BITBUCKET_MAX_CALL_INTERVAL_MS,
    logger,
  });

  logger.info(
    {
      hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
      minCallIntervalMs: config.BITBUCKET_MIN_CALL_INTERVAL_MS,
      maxCallIntervalMs: config.BITBUCKET_MAX_CALL_INTERVAL_MS,
    },
    'anonymous-sweep runner booted; starting loop',
  );

  const summary = await runAnonymousSweep({
    client,
    commitStore,
    rollupStore,
    userSummaryCache,
    logger,
  });

  logger.info(summary, 'anonymous-sweep runner exiting');
}

void main();
