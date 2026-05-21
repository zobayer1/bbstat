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

// ShipShow Score leaderboard cache (docs/scoring.md phase 4). The scoring
// rollup invalidates this namespace after every recompute via
// `invalidateAll`; readers populate it lazily on first request. Phase 4
// lands the readers — until then this only exposes the prefix + invalidator
// so the write-side wiring is correct on day one.
//
// The single-DEL invalidator uses SCAN (not KEYS) so we don't block Redis
// on a large keyspace. At the current cardinality (one entry per sort key)
// the scan touches a handful of keys, but the SCAN-based shape stays
// correct as the keyspace grows.
const LEADERBOARD_PREFIX = `${KEY_PREFIX}leaderboard:`;

export const leaderboardCache = {
  prefix: LEADERBOARD_PREFIX,
  key: (sort: string) => `${LEADERBOARD_PREFIX}${sort}`,
  async invalidateAll(cache: CacheClient): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, batch] = await cache.scan(cursor, 'MATCH', `${LEADERBOARD_PREFIX}*`, 'COUNT', 100);
      if (batch.length > 0) deleted += await cache.del(...batch);
      cursor = next;
    } while (cursor !== '0');
    return deleted;
  },
};
