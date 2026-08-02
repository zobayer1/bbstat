import { describe, it, expect, vi } from 'vitest';
import { BitbucketClient } from '../bitbucket/client.js';
import type { BitbucketCommit } from '../bitbucket/commits.js';
import type { RepositoryRow } from './discovery-store.js';
import { runEmptyRevivalTick, type EmptyRevivalDeps } from './empty-revival.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function commitsPage(values: BitbucketCommit[]): Response {
  return jsonResponse({ pagelen: 100, values });
}
function makeClient(fetchFn: typeof globalThis.fetch): BitbucketClient {
  return new BitbucketClient({
    baseUrl: 'https://api.bitbucket.org/2.0',
    email: 'a@example.com',
    token: 'tok',
    fetch: fetchFn,
    retryBaseDelayMs: 0,
  });
}
function commit(hash: string): BitbucketCommit {
  return { hash, message: 'm', date: '2026-06-01T00:00:00+00:00', parents: [], author: { raw: 'A <a@example.com>' } };
}
function repoRow(over: Partial<RepositoryRow> & { id: number; slug: string }): RepositoryRow {
  return {
    bitbucketUuid: `{${over.id}}`,
    workspace: 'acme',
    project: null,
    fullName: `acme/${over.slug}`,
    archived: false,
    syncExcluded: true,
    syncExcludeReason: 'empty-on-bitbucket',
    diffStatsExcludePatterns: [],
    ...over,
  };
}

interface FakeState {
  excludedCalls: Array<{ id: number; excluded: boolean; reason: string | null }>;
  resetCalls: number[];
}
function makeDeps(
  fetchFn: typeof globalThis.fetch,
  candidates: RepositoryRow[],
): { deps: EmptyRevivalDeps; state: FakeState } {
  const state: FakeState = { excludedCalls: [], resetCalls: [] };
  const deps: EmptyRevivalDeps = {
    client: makeClient(fetchFn),
    discoveryStore: {
      async listEmptyExcludedRepos() {
        return candidates;
      },
      async updateRepositorySyncExcluded(id, excluded, reason) {
        state.excludedCalls.push({ id, excluded, reason });
      },
    },
    commitStore: {
      async resetSyncCursors(id) {
        state.resetCalls.push(id);
      },
    },
  };
  return { deps, state };
}

const OPTS = { maxReposPerTick: 25, budgetThreshold: 10 };

describe('runEmptyRevivalTick', () => {
  it('returns queue-empty without a BB call when there are no candidates', async () => {
    const fetchMock = vi.fn();
    const { deps } = makeDeps(fetchMock as unknown as typeof globalThis.fetch, []);
    const result = await runEmptyRevivalTick(deps, OPTS);
    expect(result).toEqual({ checked: 0, revived: [], stoppedReason: 'queue-empty' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revives a repo that now has commits — clears the exclusion and resets the cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(commitsPage([commit('sha1')]));
    const { deps, state } = makeDeps(fetchMock as unknown as typeof globalThis.fetch, [
      repoRow({ id: 7, slug: 'revived' }),
    ]);
    const result = await runEmptyRevivalTick(deps, OPTS);
    expect(result.checked).toBe(1);
    expect(result.revived).toEqual(['acme/revived']);
    expect(result.stoppedReason).toBe('done');
    expect(state.excludedCalls).toEqual([{ id: 7, excluded: false, reason: null }]);
    expect(state.resetCalls).toEqual([7]);
  });

  it('leaves a still-empty repo excluded and untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(commitsPage([]));
    const { deps, state } = makeDeps(fetchMock as unknown as typeof globalThis.fetch, [
      repoRow({ id: 8, slug: 'still-empty' }),
    ]);
    const result = await runEmptyRevivalTick(deps, OPTS);
    expect(result.checked).toBe(1);
    expect(result.revived).toEqual([]);
    expect(state.excludedCalls).toEqual([]);
    expect(state.resetCalls).toEqual([]);
  });

  it('skips entirely (no BB call) when the budget is below threshold', async () => {
    const fetchMock = vi.fn();
    const { deps } = makeDeps(fetchMock as unknown as typeof globalThis.fetch, [repoRow({ id: 9, slug: 'x' })]);
    const result = await runEmptyRevivalTick(deps, { maxReposPerTick: 25, budgetThreshold: 1_000_000_000 });
    expect(result.stoppedReason).toBe('budget');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a repo excluded when the BB probe errors (e.g. 404 from a deleted repo)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ type: 'error' }, 404));
    const { deps, state } = makeDeps(fetchMock as unknown as typeof globalThis.fetch, [
      repoRow({ id: 10, slug: 'gone' }),
    ]);
    const result = await runEmptyRevivalTick(deps, OPTS);
    expect(result.checked).toBe(1);
    expect(result.revived).toEqual([]);
    expect(state.excludedCalls).toEqual([]);
  });
});
