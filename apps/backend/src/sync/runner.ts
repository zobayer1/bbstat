import type { Database } from '../db/client.js';
import type { CacheClient } from '../cache/redis.js';

export interface SyncContext {
  db: Database;
  cache: CacheClient;
  logger: { info: (msg: string, meta?: unknown) => void; error: (err: unknown) => void };
}

export interface SyncOptions {
  workspace?: string;
  repositorySlug?: string;
  trigger: 'manual' | 'cron' | 'webhook';
}

// Idempotent entrypoint shared by manual, cron, and webhook triggers.
// Implementations land here as the BitBucket ingest is built out.
export async function runSync(ctx: SyncContext, opts: SyncOptions): Promise<void> {
  ctx.logger.info(`sync start (trigger=${opts.trigger})`, opts);
  // TODO: pull from BitBucket API, upsert into Postgres, invalidate affected user summaries in Redis.
  ctx.logger.info('sync complete (no-op stub)');
}
