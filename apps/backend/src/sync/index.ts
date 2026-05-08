import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createDb } from '../db/client.js';
import { BitbucketClient } from '../bitbucket/client.js';
import { createDrizzleDiscoveryStore } from './discovery-store.js';
import { parseSeedTrackedRepos } from './discovery.js';
import { runMembersSync, runReposSync } from './runner.js';
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
  const client = new BitbucketClient({
    baseUrl: config.BITBUCKET_BASE_URL,
    email: config.BITBUCKET_AUTH_EMAIL,
    token: config.BITBUCKET_AUTH_TOKEN,
    logger,
  });
  const seeds = parseSeedTrackedRepos(config.SEED_TRACKED_REPOS);

  const deps: SyncRunnerDeps = {
    client,
    store,
    logger,
    workspace: config.BITBUCKET_WORKSPACE,
    seeds,
  };

  // Members and repos refresh on independent schedules. Members rarely
  // change; repo metadata occasionally does (project moves, renames). Both
  // ops are idempotent so a manual admin trigger that overlaps with cron is
  // fine.
  cron.schedule(config.SYNC_MEMBERS_CRON, () => {
    void runMembersSync(deps, 'cron').catch((err) => logger.error(err, 'members cron failed'));
  });

  cron.schedule(config.SYNC_REPOS_CRON, () => {
    void runReposSync(deps, 'cron').catch((err) => logger.error(err, 'repos cron failed'));
  });

  logger.info(
    {
      membersCron: config.SYNC_MEMBERS_CRON,
      reposCron: config.SYNC_REPOS_CRON,
      seedCount: seeds.length,
    },
    'Sync runner scheduled. Press Ctrl+C to exit.',
  );
}

void main();
