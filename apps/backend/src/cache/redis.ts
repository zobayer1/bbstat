import Redis from 'ioredis';

export type CacheClient = Redis;

export function createCache(redisUrl: string): CacheClient {
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
}

const USER_SUMMARY_PREFIX = 'bbstat:user-summary:';

export const userSummaryCache = {
  key: (userId: number) => `${USER_SUMMARY_PREFIX}${userId}`,
  async get<T>(cache: CacheClient, userId: number): Promise<T | null> {
    const raw = await cache.get(userSummaryCache.key(userId));
    return raw ? (JSON.parse(raw) as T) : null;
  },
  async set<T>(cache: CacheClient, userId: number, value: T, ttlSeconds = 300): Promise<void> {
    await cache.set(userSummaryCache.key(userId), JSON.stringify(value), 'EX', ttlSeconds);
  },
  async invalidate(cache: CacheClient, userId: number): Promise<void> {
    await cache.del(userSummaryCache.key(userId));
  },
};
