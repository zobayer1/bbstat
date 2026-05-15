import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { BitbucketClient } from './bitbucket/client.js';
import { createDb } from './db/client.js';
import { createDrizzleCommitStore } from './sync/commit-store.js';
import { createDrizzleDiscoveryStore } from './sync/discovery-store.js';
import { createDrizzlePrStore } from './sync/pr-store.js';
import { loadSeedTrackedRepos } from './sync/discovery.js';
import {
  backoffOptionsFromConfig,
  commitTickOptionsFromConfig,
  deepenOptionsFromConfig,
  diffStatsBackfillOptionsFromConfig,
  isMergeBackfillOptionsFromConfig,
  prTickOptionsFromConfig,
} from './sync/runner.js';
import { createCache } from './cache/redis.js';
import { createDrizzleRollupStore } from './dashboard/rollup-store.js';
import { createDrizzleStatsStore } from './dashboard/stats-store.js';
import { createRedisUserSummaryCache, type UserSummaryCache } from './dashboard/user-summary-cache.js';
import { createEventBus } from './events/bus.js';
import { wrapBusWithRedis } from './events/redis-bridge.js';
import type { UserSummary } from './dashboard/stats-store.js';
import type { SyncRunnerDeps } from './sync/runner.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV);

  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const https = {
    key: readFileSync(resolve(repoRoot, config.TLS_KEY_PATH)),
    cert: readFileSync(resolve(repoRoot, config.TLS_CERT_PATH)),
  };

  // The DB is always available (it's a hard requirement), so the read-side
  // stats store is always constructed and the dashboard endpoints are always
  // registered. BitBucket creds are optional — without them, admin / sync
  // routes are absent but the rest of the app still starts.
  const db = createDb(config.DATABASE_URL);
  const statsStore = createDrizzleStatsStore(db);
  // Shared Redis client: previously only constructed inside the BB-creds
  // branch (lazy-connect for the user-summary cache). Now also backs the
  // live-events Redis bridge, so the API process can receive events
  // published by the separate cron host process.
  const redis = createCache(config.REDIS_URL);

  // Shared event bus: the sync runner (when wired below) publishes
  // tick / auto-trip / admin events; buildApp wires it into the SSE
  // route at /api/live. The Redis bridge fans publishes out to other
  // processes (the cron host) and re-publishes their events here.
  // If Redis is unreachable at boot we fall back to the in-process bus
  // and log a loud warning — the API still serves traffic, but cron
  // events won't reach SSE clients until Redis is healthy.
  const localBus = createEventBus();
  let bus = localBus;
  try {
    bus = await wrapBusWithRedis(localBus, redis, { logger });
    logger.info({ sourceId: (bus as { sourceId?: string }).sourceId }, 'live updates: redis bridge attached');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'live updates: redis unreachable at boot — cron-host events will not reach SSE clients',
    );
  }

  let syncDeps: SyncRunnerDeps | undefined;
  // Declared at the outer scope so both syncDeps wiring (below) and buildApp
  // (further below) can share the same Redis-backed cache instance. The
  // sync hook DELs the same keys the route reads/writes.
  let userSummaryCache: UserSummaryCache<UserSummary> | undefined;
  if (config.BITBUCKET_AUTH_EMAIL && config.BITBUCKET_AUTH_TOKEN && config.BITBUCKET_WORKSPACE) {
    const discoveryStore = createDrizzleDiscoveryStore(db);
    const commitStore = createDrizzleCommitStore(db);
    const prStore = createDrizzlePrStore(db);
    const rollupStore = createDrizzleRollupStore(db);
    userSummaryCache = createRedisUserSummaryCache<UserSummary>(redis);
    const client = new BitbucketClient({
      baseUrl: config.BITBUCKET_BASE_URL,
      email: config.BITBUCKET_AUTH_EMAIL,
      token: config.BITBUCKET_AUTH_TOKEN,
      hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
      minCallIntervalMs: config.BITBUCKET_MIN_CALL_INTERVAL_MS,
      maxCallIntervalMs: config.BITBUCKET_MAX_CALL_INTERVAL_MS,
      logger,
    });
    // Seed file path: explicit env wins; otherwise default to
    // `<repo-root>/tracked-repos.yaml`. Required when explicit so a typo
    // fails loud; optional on the default path so fresh clones boot fine
    // without a seed file. We invoke the loader once at startup as a
    // fail-loud parse check, then pass the same thunk through to the
    // runner so each sync invocation re-reads the file (no-restart edits).
    const seedFilePath = resolve(repoRoot, config.SEED_REPO_FILE_PATH ?? 'tracked-repos.yaml');
    const seedRequired = config.SEED_REPO_FILE_PATH !== undefined;
    const loadSeeds = (): ReturnType<typeof loadSeedTrackedRepos> =>
      loadSeedTrackedRepos(seedFilePath, { required: seedRequired });
    loadSeeds();
    syncDeps = {
      client,
      store: discoveryStore,
      logger,
      workspace: config.BITBUCKET_WORKSPACE,
      seeds: loadSeeds,
      commitStore,
      rollupStore,
      userSummaryCache,
      commitTickOptions: commitTickOptionsFromConfig(config),
      prStore,
      prTickOptions: prTickOptionsFromConfig(config),
      deepenOptions: deepenOptionsFromConfig(config),
      isMergeBackfillOptions: isMergeBackfillOptionsFromConfig(config),
      diffStatsBackfillOptions: diffStatsBackfillOptionsFromConfig(config),
      backoffOptions: backoffOptionsFromConfig(config),
      bus,
    };
  }

  const app = await buildApp({
    config,
    logger,
    https,
    syncDeps,
    statsStore,
    bus,
    ...(userSummaryCache ? { userSummaryCache } : {}),
  });

  try {
    await app.listen({ host: '0.0.0.0', port: config.BACKEND_PORT });
    app.log.info(`Listening on https://${config.BACKEND_HOST}:${config.BACKEND_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
