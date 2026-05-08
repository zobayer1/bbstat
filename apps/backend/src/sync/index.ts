import cron from 'node-cron';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { createCache } from '../cache/redis.js';
import { runSync } from './runner.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    name: 'bbstat-sync',
    level: config.NODE_ENV === 'test' ? 'silent' : 'info',
  });
  const db = createDb(config.DATABASE_URL);
  const cache = createCache(config.REDIS_URL);
  await cache.connect();

  const ctx = {
    db,
    cache,
    logger: {
      info: (msg: string, meta?: unknown) => logger.info(meta ?? {}, msg),
      error: (err: unknown) => logger.error(err),
    },
  };

  // Cron-style trigger: every 15 minutes by default. Webhook & manual triggers reuse runSync directly.
  cron.schedule('*/15 * * * *', () => {
    void runSync(ctx, { trigger: 'cron' }).catch((err) => ctx.logger.error(err));
  });

  logger.info('Sync runner scheduled (cron */15 min). Press Ctrl+C to exit.');
}

void main();
