import { resolve } from 'node:path';
import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createDb } from '../db/client.js';
import { BitbucketClient } from '../bitbucket/client.js';
import { createDrizzleCommitStore } from './commit-store.js';
import { createDrizzleDiscoveryStore } from './discovery-store.js';
import { createDrizzlePrStore } from './pr-store.js';
import { loadSeedTrackedRepos } from './discovery.js';
import {
  backoffOptionsFromConfig,
  commitTickOptionsFromConfig,
  deepenOptionsFromConfig,
  diffStatsBackfillOptionsFromConfig,
  isMergeBackfillOptionsFromConfig,
  prTickOptionsFromConfig,
  runCommitsSync,
  runMembersSync,
  runPullRequestsSync,
  runReposSync,
} from './runner.js';
import { bitbucketAuthStateCache, createCache } from '../cache/redis.js';
import { createDrizzleRollupStore } from '../dashboard/rollup-store.js';
import { createRedisUserSummaryCache } from '../dashboard/user-summary-cache.js';
import { createEventBus } from '../events/bus.js';
import { wrapBusWithRedis } from '../events/redis-bridge.js';
import { recomputeAllScores } from '../scoring/rollup.js';
import type { SyncRunnerDeps } from './runner.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV).child({ name: 'bbstat-sync' });

  if (!config.BITBUCKET_AUTH_EMAIL || !config.BITBUCKET_AUTH_TOKEN || !config.BITBUCKET_WORKSPACE) {
    logger.warn('Sync runner skipped: BITBUCKET_AUTH_EMAIL / BITBUCKET_AUTH_TOKEN / BITBUCKET_WORKSPACE not set');
    return;
  }

  const db = createDb(config.DATABASE_URL);
  const store = createDrizzleDiscoveryStore(db);
  const commitStore = createDrizzleCommitStore(db);
  const prStore = createDrizzlePrStore(db);
  const rollupStore = createDrizzleRollupStore(db);
  const redis = createCache(config.REDIS_URL);
  const userSummaryCache = createRedisUserSummaryCache(redis);

  // Bridge the local bus through Redis so cron-published events
  // (tick.commits.complete, repository.sync-excluded, etc.) reach the
  // SSE subscribers in the separate HTTPS backend process. If Redis is
  // unreachable at boot the cron still runs — we just fall back to the
  // local in-memory bus, which means SSE clients won't see cron events
  // until Redis is healthy. Loud warning so operators notice.
  // Built before the BB client so the auth-state callback can publish
  // through it inline (no two-phase init).
  const localBus = createEventBus();
  let bus = localBus;
  try {
    bus = await wrapBusWithRedis(localBus, redis, { logger });
    logger.info({ sourceId: (bus as { sourceId?: string }).sourceId }, 'live updates: redis bridge attached');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'live updates: redis unreachable at boot — cron events will not reach SSE clients until reconnect',
    );
  }

  // Hydrate the client's auth-state from Redis so a fresh process that
  // boots into a stale 'unauthorized' flag (token rotated while we were
  // down) recovers correctly when the first 2xx lands — without this,
  // the client's internal dedupe would suppress the recovery edge and
  // the dashboard would stay red forever. Falls back to 'ok' if Redis
  // is unreachable; the next 401 re-trips it normally.
  let initialAuthState: 'ok' | 'unauthorized' = 'ok';
  try {
    initialAuthState = await bitbucketAuthStateCache.get(redis);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'bitbucket auth-state: redis read at startup failed — assuming ok',
    );
  }

  const client = new BitbucketClient({
    baseUrl: config.BITBUCKET_BASE_URL,
    email: config.BITBUCKET_AUTH_EMAIL,
    token: config.BITBUCKET_AUTH_TOKEN,
    hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
    minCallIntervalMs: config.BITBUCKET_MIN_CALL_INTERVAL_MS,
    maxCallIntervalMs: config.BITBUCKET_MAX_CALL_INTERVAL_MS,
    logger,
    initialAuthState,
    // On 401/403 we set the Redis flag and publish the SSE transition;
    // on the next 2xx we clear both. Redis writes are fire-and-forget
    // so an upstream blip never blocks the request path. Edge-triggered
    // by the client itself — see BitbucketClient.notifyAuthState.
    onAuthStateChange: (state) => {
      const op =
        state === 'unauthorized'
          ? bitbucketAuthStateCache.setUnauthorized(redis)
          : bitbucketAuthStateCache.clear(redis);
      void op.catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), state },
          'bitbucket auth-state: redis write failed',
        ),
      );
      bus.publish({ event: 'bitbucket.auth-state', payload: { state } });
    },
  });
  // Mirror the main backend entrypoint: seed path resolves against repo root
  // (apps/backend/src/sync → ../../../../), explicit path required, default
  // optional. Loader runs once at startup as a fail-loud parse check, then is
  // re-invoked by the runner on each sync so YAML edits land without restart.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
  const seedFilePath = resolve(repoRoot, config.SEED_REPO_FILE_PATH ?? 'tracked-repos.yaml');
  const seedRequired = config.SEED_REPO_FILE_PATH !== undefined;
  const loadSeeds = (): ReturnType<typeof loadSeedTrackedRepos> =>
    loadSeedTrackedRepos(seedFilePath, { required: seedRequired });
  const initialSeeds = loadSeeds();
  const commitTickOptions = commitTickOptionsFromConfig(config);
  const prTickOptions = prTickOptionsFromConfig(config);
  const deepenOptions = deepenOptionsFromConfig(config);
  const isMergeBackfillOptions = isMergeBackfillOptionsFromConfig(config);
  const diffStatsBackfillOptions = diffStatsBackfillOptionsFromConfig(config);
  const backoffOptions = backoffOptionsFromConfig(config);

  const deps: SyncRunnerDeps = {
    client,
    store,
    logger,
    workspace: config.BITBUCKET_WORKSPACE,
    seeds: loadSeeds,
    commitStore,
    rollupStore,
    userSummaryCache,
    commitTickOptions,
    prStore,
    prTickOptions,
    deepenOptions,
    isMergeBackfillOptions,
    diffStatsBackfillOptions,
    backoffOptions,
    bus,
    recomputeAllScores: () => recomputeAllScores({ db, logger }),
  };

  // Four independent schedules. Members rarely change; repo metadata
  // occasionally does; commits change constantly (tightest cadence); PRs
  // mutate slower than commits (looser cadence). Each op is idempotent —
  // overlapping manual triggers are safe.
  cron.schedule(config.SYNC_MEMBERS_CRON, () => {
    void runMembersSync(deps, 'cron').catch((err) => logger.error(err, 'members cron failed'));
  });

  cron.schedule(config.SYNC_REPOS_CRON, () => {
    void runReposSync(deps, 'cron').catch((err) => logger.error(err, 'repos cron failed'));
  });

  cron.schedule(config.SYNC_COMMITS_CRON, () => {
    void runCommitsSync(deps, 'cron').catch((err) => logger.error(err, 'commits cron failed'));
  });

  if (config.SYNC_PRS_ENABLED) {
    cron.schedule(config.SYNC_PRS_CRON, () => {
      void runPullRequestsSync(deps, 'cron').catch((err) => logger.error(err, 'PRs cron failed'));
    });
  } else {
    logger.info('PR sync cron disabled (SYNC_PRS_ENABLED=false); admin manual trigger still available');
  }

  logger.info(
    {
      membersCron: config.SYNC_MEMBERS_CRON,
      reposCron: config.SYNC_REPOS_CRON,
      commitsCron: config.SYNC_COMMITS_CRON,
      prsEnabled: config.SYNC_PRS_ENABLED,
      prsCron: config.SYNC_PRS_CRON,
      hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
      minCallIntervalMs: config.BITBUCKET_MIN_CALL_INTERVAL_MS,
      maxCallIntervalMs: config.BITBUCKET_MAX_CALL_INTERVAL_MS,
      commitTickOptions,
      prTickOptions,
      deepenOptions,
      isMergeBackfillOptions,
      diffStatsBackfillOptions,
      backoffOptions,
      seedCount: initialSeeds.length,
    },
    'Sync runner scheduled. Press Ctrl+C to exit.',
  );
}

void main();
