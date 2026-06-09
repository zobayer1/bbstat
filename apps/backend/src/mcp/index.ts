// Entrypoint for the read-only MCP server — the fourth role of the backend
// image (alongside API / sync / migrate), run as a separate compose service
// with `command: ['dist/mcp/index.js']`. Reads the same Postgres store as the
// dashboard via the in-process StatsStore; never calls BitBucket.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { createDrizzleStatsStore } from '../dashboard/stats-store.js';
import { createDb } from '../db/client.js';
import { createLogger } from '../lib/logger.js';
import { mcpPlugin } from './transport.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV);

  // Fail loud: the endpoint is meant to be exposed publicly, so refuse to
  // start without a signing secret. The other roles ignore MCP_TOKEN_SECRET,
  // so the shared config keeps it optional — this is the only enforcement.
  if (config.MCP_TOKEN_SECRET === undefined || config.MCP_TOKEN_SECRET === '') {
    logger.error('MCP_TOKEN_SECRET must be set to start the MCP server. Mint tokens with the mcp:mint-token CLI.');
    process.exit(1);
  }

  const db = createDb(config.DATABASE_URL);
  const store = createDrizzleStatsStore(db);

  // TLS parity with the API server: terminate HTTPS in-process when
  // BACKEND_TLS=on (host dev), using the shared self-signed cert. In the
  // container BACKEND_TLS=off, so we serve plain HTTP behind the proxy. The
  // image ships no certs and won't find them with BACKEND_TLS=on — same
  // constraint as the backend. repoRoot is 4 levels up from src/mcp/.
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
  const https =
    config.BACKEND_TLS === 'on'
      ? {
          key: readFileSync(resolve(repoRoot, config.TLS_KEY_PATH)),
          cert: readFileSync(resolve(repoRoot, config.TLS_CERT_PATH)),
        }
      : undefined;

  const app = Fastify({ loggerInstance: logger, ...(https ? { https } : {}) });
  await app.register(mcpPlugin, { store, secret: config.MCP_TOKEN_SECRET, logger });

  try {
    await app.listen({ host: config.MCP_HOST, port: config.MCP_PORT });
    const scheme = https ? 'https' : 'http';
    logger.info(`MCP server listening on ${scheme}://${config.MCP_HOST}:${config.MCP_PORT}/mcp`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
