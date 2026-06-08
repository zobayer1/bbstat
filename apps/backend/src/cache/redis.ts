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
const REPO_DISCOVERY_CURSOR_KEY = `${KEY_PREFIX}repo-discovery-cursor`;

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

// Workspace-repo discovery cursor: the `updated_on` of the newest repo the
// discovery sweep (src/sync/repo-discovery.ts) has processed. The sweep walks
// GET /repositories/{ws} ordered by updated_on ASC with `updated_on > <this>`,
// so it advances monotonically — backfilling the inactive tail first, then
// following newly updated / created repos. No TTL: the cursor must survive
// restarts (losing it just re-walks from the seed, which is idempotent but
// wasteful). Stored as the raw ISO string so an operator can inspect it via
// `redis-cli GET bbstat:repo-discovery-cursor`.
export const repoDiscoveryCursorCache = {
  key: REPO_DISCOVERY_CURSOR_KEY,
  async get(cache: CacheClient): Promise<string | null> {
    return await cache.get(REPO_DISCOVERY_CURSOR_KEY);
  },
  async set(cache: CacheClient, updatedOn: string): Promise<void> {
    await cache.set(REPO_DISCOVERY_CURSOR_KEY, updatedOn);
  },
  async clear(cache: CacheClient): Promise<void> {
    await cache.del(REPO_DISCOVERY_CURSOR_KEY);
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
