import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { BitbucketClient } from './bitbucket/client.js';
import { createDb } from './db/client.js';
import { createDrizzleDiscoveryStore } from './sync/discovery-store.js';
import { parseSeedTrackedRepos } from './sync/discovery.js';
import type { SyncRunnerDeps } from './sync/runner.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV);

  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const https = {
    key: readFileSync(resolve(repoRoot, config.TLS_KEY_PATH)),
    cert: readFileSync(resolve(repoRoot, config.TLS_CERT_PATH)),
  };

  // Sync deps are only built when full BitBucket credentials are configured.
  // Without them, the API server still starts (health works) but admin routes
  // are not registered and the dashboard runs without live data.
  let syncDeps: SyncRunnerDeps | undefined;
  if (config.BITBUCKET_AUTH_EMAIL && config.BITBUCKET_AUTH_TOKEN && config.BITBUCKET_WORKSPACE) {
    const db = createDb(config.DATABASE_URL);
    const store = createDrizzleDiscoveryStore(db);
    const client = new BitbucketClient({
      baseUrl: config.BITBUCKET_BASE_URL,
      email: config.BITBUCKET_AUTH_EMAIL,
      token: config.BITBUCKET_AUTH_TOKEN,
      logger,
    });
    syncDeps = {
      client,
      store,
      logger,
      workspace: config.BITBUCKET_WORKSPACE,
      seeds: parseSeedTrackedRepos(config.SEED_TRACKED_REPOS),
    };
  }

  const app = await buildApp({ config, logger, https, syncDeps });

  try {
    await app.listen({ host: '0.0.0.0', port: config.BACKEND_PORT });
    app.log.info(`Listening on https://${config.BACKEND_HOST}:${config.BACKEND_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
