import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { BitbucketClient } from './bitbucket/client.js';
import { createDb } from './db/client.js';
import { createDrizzleDiscoveryStore } from './sync/discovery-store.js';
import { parseSeedTrackedRepos } from './sync/discovery.js';
import { createDrizzleStatsStore } from './dashboard/stats-store.js';
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

  let syncDeps: SyncRunnerDeps | undefined;
  if (config.BITBUCKET_AUTH_EMAIL && config.BITBUCKET_AUTH_TOKEN && config.BITBUCKET_WORKSPACE) {
    const discoveryStore = createDrizzleDiscoveryStore(db);
    const client = new BitbucketClient({
      baseUrl: config.BITBUCKET_BASE_URL,
      email: config.BITBUCKET_AUTH_EMAIL,
      token: config.BITBUCKET_AUTH_TOKEN,
      logger,
    });
    syncDeps = {
      client,
      store: discoveryStore,
      logger,
      workspace: config.BITBUCKET_WORKSPACE,
      seeds: parseSeedTrackedRepos(config.SEED_TRACKED_REPOS),
    };
  }

  const app = await buildApp({ config, logger, https, syncDeps, statsStore });

  try {
    await app.listen({ host: '0.0.0.0', port: config.BACKEND_PORT });
    app.log.info(`Listening on https://${config.BACKEND_HOST}:${config.BACKEND_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
