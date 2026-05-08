import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from './client.js';
import { BitbucketRateLimitError } from './errors.js';

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockResponse({ status = 200, body = {}, headers = {} }: MockResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function makeClient(
  fetchFn: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof BitbucketClient>[0]> = {},
) {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'alice@example.com',
    token: 'secret-token',
    fetch: fetchFn,
    retryBaseDelayMs: 0, // keep tests fast
    ...overrides,
  });
}

describe('BitbucketClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  describe('auth + URL building', () => {
    it('sends Basic auth header with base64(email:token)', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: { ok: true } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      await client.get('/workspaces/foo');

      const [, init] = fetchMock.mock.calls[0]!;
      const expected = `Basic ${Buffer.from('alice@example.com:secret-token').toString('base64')}`;
      expect((init.headers as Record<string, string>).Authorization).toBe(expected);
      expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    });

    it('appends `fields` and `query` params correctly', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      await client.get('/workspaces/foo', {
        fields: ['uuid', 'slug', 'name'],
        query: { pagelen: 100, sort: '-updated_on', skip: undefined },
      });

      const [url] = fetchMock.mock.calls[0]!;
      const parsed = new URL(url as string);
      expect(parsed.pathname).toBe('/2.0/workspaces/foo');
      expect(parsed.searchParams.get('fields')).toBe('uuid,slug,name');
      expect(parsed.searchParams.get('pagelen')).toBe('100');
      expect(parsed.searchParams.get('sort')).toBe('-updated_on');
      expect(parsed.searchParams.has('skip')).toBe(false);
    });

    it('strips trailing slashes from baseUrl', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: {} }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, {
        baseUrl: 'https://api.bitbucket.org/2.0///',
      });

      await client.get('/workspaces/foo');

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.bitbucket.org/2.0/workspaces/foo');
    });
  });

  describe('POST + body', () => {
    it('sets Content-Type and stringifies the body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ status: 201, body: { id: 1 } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const result = await client.post('/repositories/foo/bar/webhooks', {
        body: { url: 'https://example.com/hook', events: ['repo:push'] },
      });

      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({
        url: 'https://example.com/hook',
        events: ['repo:push'],
      });
      expect(result).toEqual({ id: 1 });
    });
  });

  describe('429 rate limiting', () => {
    it('honors Retry-After and retries once', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ status: 429, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(mockResponse({ body: { ok: true } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const result = await client.get('/workspaces/foo');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: true });
    });

    it('throws BitbucketRateLimitError after exhausting retries', async () => {
      fetchMock.mockResolvedValue(mockResponse({ status: 429, headers: { 'retry-after': '0' } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { retries: 1 });

      await expect(client.get('/workspaces/foo')).rejects.toBeInstanceOf(BitbucketRateLimitError);
    });
  });

  describe('5xx retries', () => {
    it('retries on 502, returns success on next attempt', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ status: 502 }))
        .mockResolvedValueOnce(mockResponse({ body: { ok: true } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const result = await client.get('/workspaces/foo');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: true });
    });

    it('throws BitbucketApiError after exhausting 5xx retries', async () => {
      fetchMock.mockResolvedValue(mockResponse({ status: 503 }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { retries: 1 });

      await expect(client.get('/workspaces/foo')).rejects.toMatchObject({
        name: 'BitbucketApiError',
        status: 503,
      });
    });
  });

  describe('4xx (non-429) does not retry', () => {
    it('throws immediately on 404 with parsed error body', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ status: 404, body: { error: { message: 'Not found' } } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      await expect(client.get('/workspaces/missing')).rejects.toMatchObject({
        name: 'BitbucketApiError',
        status: 404,
        body: { error: { message: 'Not found' } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate-limit tracking', () => {
    it('captures X-RateLimit-* headers and exposes them via getRateLimit()', async () => {
      const resetSec = Math.floor(Date.now() / 1000) + 600;
      fetchMock.mockResolvedValueOnce(
        mockResponse({
          body: {},
          headers: {
            'x-ratelimit-limit': '1000',
            'x-ratelimit-remaining': '942',
            'x-ratelimit-reset': String(resetSec),
          },
        }),
      );
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      await client.get('/workspaces/foo');
      const rl = client.getRateLimit();

      expect(rl.limit).toBe(1000);
      expect(rl.remaining).toBe(942);
      expect(rl.resetAt).toBeInstanceOf(Date);
      expect(Math.floor(rl.resetAt!.getTime() / 1000)).toBe(resetSec);
    });

    it('warns via logger when remaining drops below threshold', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({ body: {}, headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-limit': '1000' } }),
      );
      const warn = vi.fn();
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, {
        rateLimitWarnThreshold: 100,
        logger: { warn, error: vi.fn() },
      });

      await client.get('/workspaces/foo');

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ remaining: 5, limit: 1000 }),
        'BitBucket rate-limit budget low',
      );
    });
  });

  describe('absolute URL passthrough', () => {
    it('hits absolute URLs unchanged (used by paginate following `next`)', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: { ok: true } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      await client.get('https://api.bitbucket.org/2.0/workspaces/foo/members?page=2&pagelen=100');

      const [url] = fetchMock.mock.calls[0]!;
      const parsed = new URL(url as string);
      expect(parsed.pathname).toBe('/2.0/workspaces/foo/members');
      expect(parsed.searchParams.get('page')).toBe('2');
      expect(parsed.searchParams.get('pagelen')).toBe('100');
    });
  });

  describe('paginate()', () => {
    it('yields all items from a single-page response', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse({ body: { pagelen: 100, values: [{ id: 1 }, { id: 2 }, { id: 3 }] } }),
      );
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const items: unknown[] = [];
      for await (const item of client.paginate('/workspaces/foo/members')) items.push(item);

      expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('follows `next` across multiple pages', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockResponse({
            body: {
              pagelen: 2,
              values: [{ id: 1 }, { id: 2 }],
              next: 'https://api.bitbucket.org/2.0/workspaces/foo/members?page=2&pagelen=2',
            },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            body: {
              pagelen: 2,
              values: [{ id: 3 }, { id: 4 }],
              next: 'https://api.bitbucket.org/2.0/workspaces/foo/members?page=3&pagelen=2',
            },
          }),
        )
        .mockResolvedValueOnce(mockResponse({ body: { pagelen: 2, values: [{ id: 5 }] } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const items: { id: number }[] = [];
      for await (const item of client.paginate<{ id: number }>('/workspaces/foo/members')) {
        items.push(item);
      }

      expect(items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('defaults pagelen to 100 on the initial request', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const it = client.paginate('/workspaces/foo/members');
      await it.next();

      const [url] = fetchMock.mock.calls[0]!;
      expect(new URL(url as string).searchParams.get('pagelen')).toBe('100');
    });

    it('appends `next` to the caller-supplied fields filter', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const it = client.paginate('/workspaces/foo/members', {
        fields: ['values.user.uuid', 'values.user.display_name'],
      });
      await it.next();

      const [url] = fetchMock.mock.calls[0]!;
      const fields = new URL(url as string).searchParams.get('fields')!.split(',');
      expect(fields).toContain('values.user.uuid');
      expect(fields).toContain('values.user.display_name');
      expect(fields).toContain('next');
    });

    it('does not duplicate `next` if the caller already included it', async () => {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const it = client.paginate('/workspaces/foo/members', {
        fields: ['values.user.uuid', 'next'],
      });
      await it.next();

      const [url] = fetchMock.mock.calls[0]!;
      const fields = new URL(url as string).searchParams.get('fields')!.split(',');
      expect(fields.filter((f) => f === 'next')).toHaveLength(1);
    });
  });

  describe('204 No Content', () => {
    it('resolves to undefined without parsing the body', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      const result = await client.get('/workspaces/foo/some-resource');

      expect(result).toBeUndefined();
    });
  });

  describe('outbound-call ledger (self-counted budget)', () => {
    it('counts each fetch attempt; getBudgetRemaining = budget - calls', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(mockResponse({ body: {} })));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { hourlyCallBudget: 5 });

      expect(client.getCallsInLastHour()).toBe(0);
      expect(client.getBudgetRemaining()).toBe(5);

      await client.get('/workspaces/foo');
      await client.get('/workspaces/foo');

      expect(client.getCallsInLastHour()).toBe(2);
      expect(client.getBudgetRemaining()).toBe(3);
    });

    it('counts retry attempts (429 + retry = 2 calls)', async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse({ status: 429, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(mockResponse({ body: { ok: true } }));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

      await client.get('/workspaces/foo');

      expect(client.getCallsInLastHour()).toBe(2);
    });

    it('drops timestamps older than one hour from the sliding window', async () => {
      const clock = { t: 1_000_000_000 };
      const now = (): number => clock.t;
      fetchMock.mockImplementation(() => Promise.resolve(mockResponse({ body: {} })));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { hourlyCallBudget: 100, now });

      await client.get('/workspaces/foo');
      clock.t += 30 * 60_000; // +30 min
      await client.get('/workspaces/foo');
      expect(client.getCallsInLastHour()).toBe(2);

      clock.t += 31 * 60_000; // first call now > 1h ago, second at 31min
      expect(client.getCallsInLastHour()).toBe(1);

      clock.t += 31 * 60_000; // both calls now > 1h ago
      expect(client.getCallsInLastHour()).toBe(0);
      expect(client.getBudgetRemaining()).toBe(100);
    });

    it('clamps getBudgetRemaining at zero (never goes negative)', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(mockResponse({ body: {} })));
      const client = makeClient(fetchMock as unknown as typeof globalThis.fetch, { hourlyCallBudget: 1 });

      await client.get('/a');
      await client.get('/b');
      await client.get('/c');

      expect(client.getCallsInLastHour()).toBe(3);
      expect(client.getBudgetRemaining()).toBe(0);
    });
  });
});
