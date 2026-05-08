import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createDb } from '../db/client.js';
import { BitbucketClient } from '../bitbucket/client.js';
import { createDrizzleCommitStore } from './commit-store.js';
import { createDrizzleDiscoveryStore } from './discovery-store.js';
import { parseSeedTrackedRepos } from './discovery.js';
import { commitTickOptionsFromConfig, runCommitsSync, runMembersSync, runReposSync } from './runner.js';
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
  const client = new BitbucketClient({
    baseUrl: config.BITBUCKET_BASE_URL,
    email: config.BITBUCKET_AUTH_EMAIL,
    token: config.BITBUCKET_AUTH_TOKEN,
    hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
    logger,
  });
  const seeds = parseSeedTrackedRepos(config.SEED_TRACKED_REPOS);
  const commitTickOptions = commitTickOptionsFromConfig(config);

  const deps: SyncRunnerDeps = {
    client,
    store,
    logger,
    workspace: config.BITBUCKET_WORKSPACE,
    seeds,
    commitStore,
    commitTickOptions,
  };

  // Three independent schedules. Members rarely change; repo metadata
  // occasionally does; commits change constantly so they run on the tightest
  // cadence. Each op is idempotent — overlapping manual triggers are safe.
  cron.schedule(config.SYNC_MEMBERS_CRON, () => {
    void runMembersSync(deps, 'cron').catch((err) => logger.error(err, 'members cron failed'));
  });

  cron.schedule(config.SYNC_REPOS_CRON, () => {
    void runReposSync(deps, 'cron').catch((err) => logger.error(err, 'repos cron failed'));
  });

  cron.schedule(config.SYNC_COMMITS_CRON, () => {
    void runCommitsSync(deps, 'cron').catch((err) => logger.error(err, 'commits cron failed'));
  });

  logger.info(
    {
      membersCron: config.SYNC_MEMBERS_CRON,
      reposCron: config.SYNC_REPOS_CRON,
      commitsCron: config.SYNC_COMMITS_CRON,
      hourlyCallBudget: config.BITBUCKET_HOURLY_CALL_BUDGET,
      commitTickOptions,
      seedCount: seeds.length,
    },
    'Sync runner scheduled. Press Ctrl+C to exit.',
  );
}

void main();
