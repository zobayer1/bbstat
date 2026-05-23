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
const BITBUCKET_AUTH_STATE_KEY = `${KEY_PREFIX}bitbucket-auth-state`;

// Subtle dashboard signal: when BitBucket returns 401/403 (token expired,
// scopes revoked, or repo access pulled), the `BitbucketClient` fires its
// `onAuthStateChange` hook and we flip this flag. The next successful 2xx
// clears it. The dashboard reads this (via SSE event + a one-shot REST
// fetch on mount) and colors the `!!` glyph red while set. No TTL —
// presence is the signal; absence (key missing) means healthy.
//
// Stored as a plain string `"unauthorized"` rather than a sub-keyed hash
// so a curious operator can `redis-cli GET bbstat:bitbucket-auth-state`
// and see the state at a glance.
export const bitbucketAuthStateCache = {
  key: BITBUCKET_AUTH_STATE_KEY,
  async get(cache: CacheClient): Promise<'ok' | 'unauthorized'> {
    const raw = await cache.get(BITBUCKET_AUTH_STATE_KEY);
    return raw === 'unauthorized' ? 'unauthorized' : 'ok';
  },
  async setUnauthorized(cache: CacheClient): Promise<void> {
    await cache.set(BITBUCKET_AUTH_STATE_KEY, 'unauthorized');
  },
  async clear(cache: CacheClient): Promise<void> {
    await cache.del(BITBUCKET_AUTH_STATE_KEY);
  },
};

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
