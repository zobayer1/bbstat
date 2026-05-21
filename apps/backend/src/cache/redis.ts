import { Redis } from 'ioredis';

export type CacheClient = Redis;

export function createCache(redisUrl: string): CacheClient {
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
}

// Every Redis key this application writes MUST start with `bbstat:` so a
// shared Redis instance can host multiple apps without collisions, and so
// `KEYS bbstat:*` / `SCAN MATCH bbstat:*` cleanly enumerates only our keys.
// Per CLAUDE.md, Redis is user-summary only today — future namespaces, if
// they ever land, should compose from this same root.
export const KEY_PREFIX = 'bbstat:';

const USER_SUMMARY_PREFIX = `${KEY_PREFIX}user-summary:`;

export const userSummaryCache = {
  key: (userId: number) => `${USER_SUMMARY_PREFIX}${userId}`,
  async get<T>(cache: CacheClient, userId: number): Promise<T | null> {
    const raw = await cache.get(userSummaryCache.key(userId));
    return raw ? (JSON.parse(raw) as T) : null;
  },
  // 1h default TTL. The hard invalidation from the sync hook does the real
  // freshness work; the TTL is a backstop. Callers that need different
  // semantics (tests, scripts) can override.
  async set<T>(cache: CacheClient, userId: number, value: T, ttlSeconds = 3600): Promise<void> {
    await cache.set(userSummaryCache.key(userId), JSON.stringify(value), 'EX', ttlSeconds);
  },
  async invalidate(cache: CacheClient, userId: number): Promise<void> {
    await cache.del(userSummaryCache.key(userId));
  },
};
