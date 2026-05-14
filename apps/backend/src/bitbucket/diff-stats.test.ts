import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitbucketClient } from './client.js';
import { DIFF_STAT_FIELDS, getCommitDiffStat } from './diff-stats.js';

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

describe('getCommitDiffStat', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('hits the right path with field filter and pagelen=100', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    await getCommitDiffStat(client, 'workspace-foo', 'repo-bar', 'sha-abc');

    const [url] = fetchMock.mock.calls[0]!;
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe('/2.0/repositories/workspace-foo/repo-bar/diffstat/sha-abc');
    expect(parsed.searchParams.get('pagelen')).toBe('100');

    const fields = parsed.searchParams.get('fields')!.split(',');
    for (const f of DIFF_STAT_FIELDS) {
      expect(fields).toContain(f);
    }
    expect(fields).toContain('next');
  });

  it('every field-filter entry is values.-prefixed (paginated endpoint requirement)', () => {
    for (const f of DIFF_STAT_FIELDS) {
      expect(f.startsWith('values.')).toBe(true);
    }
  });

  it('sums lines_added / lines_removed across files in a single page', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        body: {
          pagelen: 100,
          values: [
            { lines_added: 10, lines_removed: 2 },
            { lines_added: 5, lines_removed: 0 },
            { lines_added: 0, lines_removed: 7 },
          ],
        },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await getCommitDiffStat(client, 'ws', 'repo', 'sha-multi');

    expect(result).toEqual({ additions: 15, deletions: 9, filesChanged: 3 });
  });

  it('returns zero for an empty diffstat (e.g., merge commit with no file changes)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { pagelen: 100, values: [] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    expect(await getCommitDiffStat(client, 'ws', 'repo', 'sha-empty')).toEqual({
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    });
  });

  it('treats null lines_added / lines_removed as zero (binary files), but still counts the file', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        body: {
          pagelen: 100,
          values: [
            { lines_added: 3, lines_removed: 1 },
            { lines_added: null, lines_removed: null },
          ],
        },
      }),
    );
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    expect(await getCommitDiffStat(client, 'ws', 'repo', 'sha-binary')).toEqual({
      additions: 3,
      deletions: 1,
      filesChanged: 2,
    });
  });

  it('follows `next` and sums across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          body: {
            pagelen: 1,
            values: [{ lines_added: 100, lines_removed: 10 }],
            next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/diffstat/sha?page=2',
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ body: { pagelen: 1, values: [{ lines_added: 50, lines_removed: 5 }] } }));
    const client = makeClient(fetchMock as unknown as typeof globalThis.fetch);

    const result = await getCommitDiffStat(client, 'ws', 'repo', 'sha-large');

    expect(result).toEqual({ additions: 150, deletions: 15, filesChanged: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
