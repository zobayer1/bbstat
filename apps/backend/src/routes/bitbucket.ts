// GET /api/bitbucket/auth-state — one-shot read of the BitBucket auth
// health flag the `BitbucketClient`'s `onAuthStateChange` hook maintains
// in Redis. Used by the dashboard on mount to set the initial color of
// the `!!` glyph before any SSE event has arrived. After mount, the
// `bitbucket.auth-state` SSE event drives transitions.
//
// Always returns a well-formed payload — when Redis isn't wired (unit
// tests, fresh dev with no BB creds) we return 'ok' so the UI doesn't
// false-alarm.

import type { FastifyPluginAsync } from 'fastify';
import { bitbucketAuthStateCache, type CacheClient } from '../cache/redis.js';

export interface BitbucketRoutesOptions {
  // Optional Redis client. Without it, the route always returns 'ok' —
  // the BB client never had a chance to flip the flag anyway.
  redis?: CacheClient;
}

export const bitbucketRoutes: FastifyPluginAsync<BitbucketRoutesOptions> = async (app, opts) => {
  app.get('/auth-state', async () => {
    if (!opts.redis) return { state: 'ok' as const };
    try {
      const state = await bitbucketAuthStateCache.get(opts.redis);
      return { state };
    } catch (err) {
      // Redis unreachable — treat as healthy so the dashboard doesn't
      // turn red because of an infrastructure blip on our side.
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'bitbucket auth-state: redis read failed — defaulting to ok',
      );
      return { state: 'ok' as const };
    }
  });
};
