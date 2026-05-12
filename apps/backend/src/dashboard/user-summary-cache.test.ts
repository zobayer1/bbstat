import { describe, expect, it, vi } from 'vitest';
import { KEY_PREFIX, type CacheClient, userSummaryCache } from '../cache/redis.js';
import {
  USER_SUMMARY_TTL_SECONDS,
  createNoopUserSummaryCache,
  createRedisUserSummaryCache,
} from './user-summary-cache.js';

interface FakeRedis {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function fakeRedis(): FakeRedis {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
}

describe('Redis key prefix discipline', () => {
  it('exposes the bbstat: root prefix', () => {
    expect(KEY_PREFIX).toBe('bbstat:');
  });

  it('builds user-summary keys under the bbstat: namespace', () => {
    const key = userSummaryCache.key(42);
    expect(key).toBe('bbstat:user-summary:42');
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
  });
});

describe('createRedisUserSummaryCache', () => {
  it('namespaces keys and parses JSON on get', async () => {
    const redis = fakeRedis();
    redis.get.mockResolvedValue('{"foo":"bar"}');
    const cache = createRedisUserSummaryCache<{ foo: string }>(redis as unknown as CacheClient);

    const value = await cache.get(42);

    expect(redis.get).toHaveBeenCalledWith('bbstat:user-summary:42');
    expect(value).toEqual({ foo: 'bar' });
  });

  it('returns null on cache miss', async () => {
    const redis = fakeRedis();
    redis.get.mockResolvedValue(null);
    const cache = createRedisUserSummaryCache(redis as unknown as CacheClient);

    expect(await cache.get(1)).toBeNull();
  });

  it('writes with the 1h TTL', async () => {
    const redis = fakeRedis();
    const cache = createRedisUserSummaryCache(redis as unknown as CacheClient);

    await cache.set(7, { total: 12 });

    expect(redis.set).toHaveBeenCalledWith('bbstat:user-summary:7', '{"total":12}', 'EX', USER_SUMMARY_TTL_SECONDS);
    expect(USER_SUMMARY_TTL_SECONDS).toBe(3600);
  });

  it('deletes the namespaced key on invalidate', async () => {
    const redis = fakeRedis();
    const cache = createRedisUserSummaryCache(redis as unknown as CacheClient);

    await cache.invalidate(13);

    expect(redis.del).toHaveBeenCalledWith('bbstat:user-summary:13');
  });
});

describe('createNoopUserSummaryCache', () => {
  it('always misses on get and silently accepts set/invalidate', async () => {
    const cache = createNoopUserSummaryCache<{ x: number }>();

    expect(await cache.get(1)).toBeNull();
    await expect(cache.set(1, { x: 5 })).resolves.toBeUndefined();
    await expect(cache.invalidate(1)).resolves.toBeUndefined();
  });
});
