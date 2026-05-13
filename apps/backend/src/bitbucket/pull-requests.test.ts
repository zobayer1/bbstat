import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from './client.js';
import { PR_LIST_FIELDS, paginatePullRequests, type BitbucketPullRequest } from './pull-requests.js';

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

const SAMPLE_PR: BitbucketPullRequest = {
  id: 42,
  title: 'feat: shiny new thing',
  state: 'OPEN',
  source: { branch: { name: 'feature-shiny' }, commit: { hash: 'src-sha' } },
  destination: { branch: { name: 'main' }, commit: { hash: 'dst-sha' } },
  author: { uuid: '{author-1}' },
  created_on: '2026-05-08T12:00:00+00:00',
  updated_on: '2026-05-09T18:00:00+00:00',
  closed_on: null,
  comment_count: 3,
  task_count: 0,
};

describe('paginatePullRequests', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('hits the right path with all four state filters + sort=-updated_on + pagelen=50', async () => {
    // BB Cloud caps /pullrequests pagelen at 50 (unlike /commits at 100);
    // we override the client's 100 default explicitly here.
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 50, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const iter = paginatePullRequests(client, 'workspace-foo', 'repo-bar');
    await iter.next();

    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/2.0/repositories/workspace-foo/repo-bar/pullrequests');
    expect(parsed.searchParams.getAll('state').sort()).toEqual(['DECLINED', 'MERGED', 'OPEN', 'SUPERSEDED']);
    expect(parsed.searchParams.get('sort')).toBe('-updated_on');
    expect(parsed.searchParams.get('pagelen')).toBe('50');
  });

  it('requests the field-filter set and includes `next`', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const iter = paginatePullRequests(client, 'ws', 'repo');
    await iter.next();

    const [url] = fetchMock.mock.calls[0]!;
    const fields = new URL(url as string).searchParams.get('fields')!.split(',');
    for (const f of PR_LIST_FIELDS) {
      expect(fields).toContain(f);
    }
    expect(fields).toContain('next');
  });

  it('every field-filter entry is values.-prefixed (paginated endpoint requirement)', () => {
    for (const f of PR_LIST_FIELDS) {
      expect(f.startsWith('values.')).toBe(true);
    }
  });

  it('yields each PR from a single-page response', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [SAMPLE_PR] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const out: BitbucketPullRequest[] = [];
    for await (const p of paginatePullRequests(client, 'ws', 'repo')) out.push(p);

    expect(out).toEqual([SAMPLE_PR]);
  });

  it('follows `next` across multiple pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          body: {
            pagelen: 1,
            values: [{ ...SAMPLE_PR, id: 1 }],
            next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?page=2',
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ body: { pagelen: 1, values: [{ ...SAMPLE_PR, id: 2 }] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const ids: number[] = [];
    for await (const p of paginatePullRequests(client, 'ws', 'repo')) ids.push(p.id);

    expect(ids).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles PRs without `author` (anonymous / deleted BB account)', async () => {
    const anon: BitbucketPullRequest = {
      ...SAMPLE_PR,
      id: 99,
      title: 'orphan PR',
    };
    delete (anon as { author?: { uuid: string } }).author;
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [anon] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const out: BitbucketPullRequest[] = [];
    for await (const p of paginatePullRequests(client, 'ws', 'repo')) out.push(p);

    expect(out[0]!.author).toBeUndefined();
    expect(out[0]!.id).toBe(99);
  });

  it('handles PRs without source/destination commit hashes (e.g., declined w/o merge)', async () => {
    const noCommits: BitbucketPullRequest = {
      ...SAMPLE_PR,
      id: 7,
      state: 'DECLINED',
      source: { branch: { name: 'feature' } },
      destination: { branch: { name: 'main' } },
      closed_on: '2026-05-09T20:00:00+00:00',
    };
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [noCommits] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const out: BitbucketPullRequest[] = [];
    for await (const p of paginatePullRequests(client, 'ws', 'repo')) out.push(p);

    expect(out[0]!.source.commit).toBeUndefined();
    expect(out[0]!.destination.commit).toBeUndefined();
    expect(out[0]!.closed_on).toBe('2026-05-09T20:00:00+00:00');
  });

  it('lets the caller stop iteration early (delta-sync use case)', async () => {
    const prs = [
      { ...SAMPLE_PR, id: 100, updated_on: '2026-05-09T18:00:00+00:00' },
      { ...SAMPLE_PR, id: 99, updated_on: '2026-05-08T12:00:00+00:00' }, // cursor match
      { ...SAMPLE_PR, id: 98, updated_on: '2026-05-07T08:00:00+00:00' },
    ];
    fetchMock.mockResolvedValue(mockResponse({ body: { pagelen: 100, values: prs } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const seen: number[] = [];
    for await (const p of paginatePullRequests(client, 'ws', 'repo')) {
      seen.push(p.id);
      if (p.id === 99) break;
    }

    expect(seen).toEqual([100, 99]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
