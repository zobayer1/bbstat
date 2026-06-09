// Entrypoint for the read-only MCP server — the fourth role of the backend
// image (alongside API / sync / migrate), run as a separate compose service
// with `command: ['dist/mcp/index.js']`. Reads the same Postgres store as the
// dashboard via the in-process StatsStore; never calls BitBucket.

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

  const app = Fastify({ loggerInstance: logger });
  await app.register(mcpPlugin, { store, secret: config.MCP_TOKEN_SECRET, logger });

  try {
    await app.listen({ host: config.MCP_HOST, port: config.MCP_PORT });
    logger.info(`MCP server listening on http://${config.MCP_HOST}:${config.MCP_PORT}/mcp`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
