// GET /api/bitbucket/auth-state — one-shot read of the BitBucket auth health
// flag maintained in Redis by BitbucketClient's onAuthStateChange hook. The
// dashboard reads it on mount to color the `!!` glyph before any SSE event
// arrives; afterwards the `bitbucket.auth-state` SSE event drives transitions.
// Defaults to 'ok' when Redis isn't wired so the UI doesn't false-alarm.

import type { FastifyPluginAsync } from 'fastify';
import { bitbucketAuthStateCache, type CacheClient } from '../cache/redis.js';

export interface BitbucketRoutesOptions {
  redis?: CacheClient;
}

export const bitbucketRoutes: FastifyPluginAsync<BitbucketRoutesOptions> = async (app, opts) => {
  app.get('/auth-state', async () => {
    if (!opts.redis) return { state: 'ok' as const };
    try {
      const state = await bitbucketAuthStateCache.get(opts.redis);
      return { state };
    } catch (err) {
      // Redis unreachable — treat as healthy so the dashboard doesn't turn red
      // over an infrastructure blip on our side.
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'bitbucket auth-state: redis read failed — defaulting to ok',
      );
      return { state: 'ok' as const };
    }
  });
};
