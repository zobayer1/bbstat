import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from './client.js';
import { COMMIT_LIST_FIELDS, paginateCommits, type BitbucketCommit } from './commits.js';

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

function makeClient(fetchFn: typeof globalThis.fetch) {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'alice@example.com',
    token: 'secret-token',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
  });
}

const SAMPLE_COMMIT: BitbucketCommit = {
  hash: 'a1b2c3d4',
  message: 'Initial commit',
  date: '2026-05-01T12:00:00+00:00',
  parents: [],
  author: {
    raw: 'Alice <alice@example.com>',
    user: { uuid: '{user-uuid-1}', display_name: 'Alice' },
  },
};

describe('paginateCommits', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('hits the right path with field filter and pagelen=100', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const iter = paginateCommits(client, 'workspace-foo', 'repo-bar');
    await iter.next();

    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/2.0/repositories/workspace-foo/repo-bar/commits');
    expect(parsed.searchParams.get('pagelen')).toBe('100');

    const fields = parsed.searchParams.get('fields')!.split(',');
    for (const f of COMMIT_LIST_FIELDS) {
      expect(fields).toContain(f);
    }
    // paginate() must add `next` so iteration doesn't stop after page 1.
    expect(fields).toContain('next');
  });

  it('every field-filter entry is values.-prefixed (paginated endpoint requirement)', () => {
    for (const f of COMMIT_LIST_FIELDS) {
      expect(f.startsWith('values.')).toBe(true);
    }
  });

  it('forwards `include` as a query param', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const iter = paginateCommits(client, 'ws', 'repo', { include: 'feature-branch' });
    await iter.next();

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get('include')).toBe('feature-branch');
  });

  it('omits `include` when not provided', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const iter = paginateCommits(client, 'ws', 'repo');
    await iter.next();

    const [url] = fetchMock.mock.calls[0]!;
    expect(new URL(url as string).searchParams.has('include')).toBe(false);
  });

  it('yields each commit from a single-page response', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [SAMPLE_COMMIT] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const out: BitbucketCommit[] = [];
    for await (const c of paginateCommits(client, 'ws', 'repo')) out.push(c);

    expect(out).toEqual([SAMPLE_COMMIT]);
  });

  it('follows `next` across multiple pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          body: {
            pagelen: 1,
            values: [{ ...SAMPLE_COMMIT, hash: 'sha1' }],
            next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/commits?page=2',
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ body: { pagelen: 1, values: [{ ...SAMPLE_COMMIT, hash: 'sha2' }] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const hashes: string[] = [];
    for await (const c of paginateCommits(client, 'ws', 'repo')) hashes.push(c.hash);

    expect(hashes).toEqual(['sha1', 'sha2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles commits without `author.user` (anonymous / unmatched author)', async () => {
    const anon: BitbucketCommit = {
      hash: 'anon-1',
      message: 'External contributor',
      date: '2026-05-01T00:00:00+00:00',
      parents: [{ hash: 'parent-1' }],
      author: { raw: 'Bob <bob@example.com>' },
    };
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [anon] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const out: BitbucketCommit[] = [];
    for await (const c of paginateCommits(client, 'ws', 'repo')) out.push(c);

    expect(out[0]!.author.user).toBeUndefined();
    expect(out[0]!.author.raw).toBe('Bob <bob@example.com>');
  });

  it('lets the caller stop iteration early (delta-sync use case)', async () => {
    const commits = [
      { ...SAMPLE_COMMIT, hash: 'sha-newest' },
      { ...SAMPLE_COMMIT, hash: 'sha-known' },
      { ...SAMPLE_COMMIT, hash: 'sha-old' },
    ];
    fetchMock.mockResolvedValue(mockResponse({ body: { pagelen: 100, values: commits } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const seen: string[] = [];
    for await (const c of paginateCommits(client, 'ws', 'repo')) {
      seen.push(c.hash);
      if (c.hash === 'sha-known') break;
    }

    expect(seen).toEqual(['sha-newest', 'sha-known']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
