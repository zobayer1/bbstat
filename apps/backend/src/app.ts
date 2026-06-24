import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import type { Logger } from 'pino';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { statsRoutes } from './routes/stats.js';
import { activityRoutes } from './routes/activity.js';
import { liveRoutes } from './routes/live.js';
import { bitbucketRoutes } from './routes/bitbucket.js';
import { createEventBus, type EventBus } from './events/bus.js';
import type { AppConfig } from './config.js';
import type { SyncRunnerDeps } from './sync/runner.js';
import type { StatsStore, UserSummary } from './dashboard/stats-store.js';
import type { UserSummaryCache } from './dashboard/user-summary-cache.js';
import type { CacheClient } from './cache/redis.js';

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  https?: { key: Buffer; cert: Buffer };
  // When set, /api/admin/* routes are registered; absent without BB creds.
  syncDeps?: SyncRunnerDeps;
  // When set, /api/stats/* dashboard read endpoints are registered.
  statsStore?: StatsStore;
  // When wired alongside statsStore, /users/:id/summary uses it as a
  // read-through cache.
  userSummaryCache?: UserSummaryCache<UserSummary>;
  // Live-updates event bus. When omitted a fresh one is created — runtime
  // callers pass an instance shared with the sync runner so publish() events
  // fan out to SSE subscribers.
  bus?: EventBus;
  // Shared Redis client backing `/api/bitbucket/auth-state`. Without it the
  // route still registers and returns 'ok'.
  redis?: CacheClient;
}

export async function buildApp({
  config,
  logger,
  https,
  syncDeps,
  statsStore,
  userSummaryCache,
  bus,
  redis,
}: BuildAppOptions) {
  // Fastify 5: a pre-built pino instance goes on `loggerInstance`, not `logger`
  // (which is for config).
  const app = Fastify({
    loggerInstance: logger,
    ...(https ? { https } : {}),
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: true,
    credentials: false,
  });
  await app.register(healthRoutes);

  const eventBus = bus ?? createEventBus();
  await app.register(liveRoutes, { prefix: '/api', bus: eventBus });

  await app.register(bitbucketRoutes, { prefix: '/api/bitbucket', ...(redis ? { redis } : {}) });

  if (syncDeps) {
    await app.register(adminRoutes, { prefix: '/api/admin', syncDeps });
  } else {
    app.log.warn('BitBucket credentials not configured — /api/admin routes are not registered');
  }

  if (statsStore) {
    await app.register(statsRoutes, {
      prefix: '/api/stats',
      statsStore,
      ...(userSummaryCache ? { userSummaryCache } : {}),
    });
    await app.register(activityRoutes, { prefix: '/api', statsStore });
  }

  // Suppress unused-warnings on config for consumers that may extend this.
  void config;
  return app;
}
