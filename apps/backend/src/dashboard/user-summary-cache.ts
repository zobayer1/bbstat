// Interface + factories for the user-summary cache.
//
// Both the read side (route handler for /api/stats/users/:id/summary) and
// the write-side trigger (sync runner's per-repo success hook) depend on
// this interface so they can be tested with an in-memory fake instead of
// a live Redis. Per CLAUDE.md, Redis is **only** for user-summary rollups —
// don't grow this surface into a generic key-value layer.

import { userSummaryCache as redisHelpers, type CacheClient } from '../cache/redis.js';

// 1h soft cache. Hard invalidation comes from the sync hook the moment new
// commits land for the user (see rollup-hook follow-up in T13), so the TTL
// is really only a backstop for users who haven't pushed in a while.
export const USER_SUMMARY_TTL_SECONDS = 3600;

export interface UserSummaryCache<T = unknown> {
  get(userId: number): Promise<T | null>;
  set(userId: number, value: T): Promise<void>;
  invalidate(userId: number): Promise<void>;
}

export function createRedisUserSummaryCache<T = unknown>(redis: CacheClient): UserSummaryCache<T> {
  return {
    async get(userId) {
      return redisHelpers.get<T>(redis, userId);
    },
    async set(userId, value) {
      await redisHelpers.set(redis, userId, value, USER_SUMMARY_TTL_SECONDS);
    },
    async invalidate(userId) {
      await redisHelpers.invalidate(redis, userId);
    },
  };
}

// Drop-in cache for environments without a configured Redis (tests, or a
// dev box that skipped `make up`). Reads always miss → the route falls
// through to the DB; writes are silent no-ops.
export function createNoopUserSummaryCache<T = unknown>(): UserSummaryCache<T> {
  return {
    async get() {
      return null;
    },
    async set() {
      /* intentional no-op */
    },
    async invalidate() {
      /* intentional no-op */
    },
  };
}
