import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import type { Logger } from 'pino';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import { statsRoutes } from './routes/stats.js';
import { activityRoutes } from './routes/activity.js';
import type { AppConfig } from './config.js';
import type { SyncRunnerDeps } from './sync/runner.js';
import type { StatsStore, UserSummary } from './dashboard/stats-store.js';
import type { UserSummaryCache } from './dashboard/user-summary-cache.js';

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  https?: { key: Buffer; cert: Buffer };
  // When set, /api/admin/* routes are registered. Without it (e.g., a fresh
  // dev environment with no BitBucket creds, or a test that doesn't need the
  // sync surface), the admin routes are simply absent.
  syncDeps?: SyncRunnerDeps;
  // When set, /api/stats/* dashboard read endpoints are registered.
  statsStore?: StatsStore;
  // Optional. When wired alongside statsStore, /users/:id/summary uses it
  // as a read-through cache. Absent in unit tests that don't care.
  userSummaryCache?: UserSummaryCache<UserSummary>;
}

export async function buildApp({ config, logger, https, syncDeps, statsStore, userSummaryCache }: BuildAppOptions) {
  // Fastify 5: a pre-built pino instance goes on `loggerInstance`, not `logger`
  // (which is for config). Same instance ends up at app.log either way.
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
