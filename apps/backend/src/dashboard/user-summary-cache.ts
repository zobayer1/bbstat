// Interface + factories for the user-summary cache. Per CLAUDE.md, Redis is
// **only** for user-summary rollups — don't grow this into a generic KV layer.

import { userSummaryCache as redisHelpers, type CacheClient } from '../cache/redis.js';

// 1h soft cache. Hard invalidation comes from the sync hook the moment new
// commits land for the user, so the TTL only backstops inactive users.
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

// Drop-in for environments without Redis: reads always miss (route falls
// through to the DB), writes are silent no-ops.
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
