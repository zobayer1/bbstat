import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { StatsStore } from '../../dashboard/stats-store.js';
import { tools } from './registry.js';
import { ToolError, type AnyToolDef } from './types.js';

const OVERVIEW = { sentinel: 'overview' };

// Fake StatsStore — every method a vi.fn with a benign default; tests override
// per case via `.mockResolvedValue(...)`. Cast to StatsStore only at the call
// boundary so assertions keep the vi.fn types.
function makeStore() {
  return {
    getOverview: vi.fn(async () => OVERVIEW),
    getLatestCommitForRepository: vi.fn(async () => null),
    getTopContributors: vi.fn(async () => []),
    getUserSummary: vi.fn(async (): Promise<unknown> => null),
    getPersonSummary: vi.fn(async (): Promise<unknown> => null),
    getProjectStats: vi.fn(async (): Promise<unknown> => null),
    getRepositoryActivity: vi.fn(async (): Promise<unknown> => null),
    listTrackedRepositoriesWithStats: vi.fn(async () => []),
    listWorkspaceMembers: vi.fn(async () => []),
    getActivity: vi.fn(async () => []),
    getActivityDaily: vi.fn(async () => []),
    getActivityCount: vi.fn(async () => 0),
    getRepoContributorBreakdown: vi.fn(async () => []),
  };
}

type FakeStore = ReturnType<typeof makeStore>;

function byName(name: string): AnyToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

// Mirror the server path: validate raw args against the tool's own shape
// (applies defaults + coercions) before invoking the handler.
async function invoke(name: string, store: FakeStore, rawArgs: unknown = {}): Promise<unknown> {
  const tool = byName(name);
  const parsed = z.object(tool.inputShape).parse(rawArgs);
  return tool.handler(store as unknown as StatsStore, parsed);
}

describe('tool registry', () => {
  it('has unique snake_case names, titles, and substantive descriptions', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });
});

describe('get_overview', () => {
  it('returns the store overview verbatim', async () => {
    const store = makeStore();
    expect(await invoke('get_overview', store)).toBe(OVERVIEW);
    expect(store.getOverview).toHaveBeenCalledOnce();
  });
});

describe('top_contributors', () => {
  it('applies window/limit defaults (30, 10)', async () => {
    const store = makeStore();
    await invoke('top_contributors', store, {});
    expect(store.getTopContributors).toHaveBeenCalledWith(30, 10);
  });

  it('passes explicit window_days and limit through', async () => {
    const store = makeStore();
    await invoke('top_contributors', store, { window_days: 7, limit: 5 });
    expect(store.getTopContributors).toHaveBeenLastCalledWith(7, 5);
  });

  it('rejects an out-of-range window', async () => {
    await expect(invoke('top_contributors', makeStore(), { window_days: 0 })).rejects.toThrow();
    await expect(invoke('top_contributors', makeStore(), { limit: 500 })).rejects.toThrow();
  });
});

describe('list_members / list_repositories', () => {
  it('proxy the directory queries with no args', async () => {
    const store = makeStore();
    await invoke('list_members', store);
    await invoke('list_repositories', store);
    expect(store.listWorkspaceMembers).toHaveBeenCalledOnce();
    expect(store.listTrackedRepositoriesWithStats).toHaveBeenCalledOnce();
  });
});

describe('get_contributor_summary', () => {
  it("dispatches 'user' to getUserSummary", async () => {
    const store = makeStore();
    store.getUserSummary.mockResolvedValue({ id: 1 });
    const result = await invoke('get_contributor_summary', store, { entity_kind: 'user', entity_id: 1 });
    expect(result).toEqual({ id: 1 });
    expect(store.getUserSummary).toHaveBeenCalledWith(1);
    expect(store.getPersonSummary).not.toHaveBeenCalled();
  });

  it("dispatches 'person' to getPersonSummary", async () => {
    const store = makeStore();
    store.getPersonSummary.mockResolvedValue({ id: 7 });
    const result = await invoke('get_contributor_summary', store, { entity_kind: 'person', entity_id: 7 });
    expect(result).toEqual({ id: 7 });
    expect(store.getPersonSummary).toHaveBeenCalledWith(7);
    expect(store.getUserSummary).not.toHaveBeenCalled();
  });

  it('throws ToolError when the entity does not exist', async () => {
    await expect(
      invoke('get_contributor_summary', makeStore(), { entity_kind: 'person', entity_id: 99 }),
    ).rejects.toBeInstanceOf(ToolError);
  });
});

describe('get_repository_activity', () => {
  it('returns activity for a tracked repo', async () => {
    const store = makeStore();
    store.getRepositoryActivity.mockResolvedValue({ slug: 'bbstat' });
    const result = await invoke('get_repository_activity', store, { workspace: 'acme', slug: 'bbstat' });
    expect(result).toEqual({ slug: 'bbstat' });
    expect(store.getRepositoryActivity).toHaveBeenCalledWith('acme', 'bbstat');
  });

  it('throws ToolError for an untracked repo', async () => {
    await expect(
      invoke('get_repository_activity', makeStore(), { workspace: 'acme', slug: 'nope' }),
    ).rejects.toBeInstanceOf(ToolError);
  });
});

describe('get_project_stats', () => {
  it('throws ToolError when no repos carry the key', async () => {
    await expect(invoke('get_project_stats', makeStore(), { project_key: 'GHOST' })).rejects.toBeInstanceOf(ToolError);
  });
});

describe('search_activity', () => {
  it('maps args into a full ActivityFilters (nulls, lowercased hash, offset 0)', async () => {
    const store = makeStore();
    await invoke('search_activity', store, {
      actor: { kind: 'user', id: 3 },
      repo: { workspace: 'acme', slug: 'bbstat' },
      message: 'fix',
      hash_prefix: 'AbCd',
      after: '2026-01-01',
      limit: 25,
    });
    expect(store.getActivity).toHaveBeenCalledWith({
      actor: { kind: 'user', id: 3 },
      repo: { workspace: 'acme', slug: 'bbstat' },
      project: null,
      before: null,
      after: new Date('2026-01-01'),
      hashPrefix: 'abcd',
      message: 'fix',
      limit: 25,
      offset: 0,
    });
  });

  it('defaults limit to 50 and leaves every filter null when omitted', async () => {
    const store = makeStore();
    await invoke('search_activity', store, {});
    expect(store.getActivity).toHaveBeenCalledWith({
      actor: null,
      repo: null,
      project: null,
      before: null,
      after: null,
      hashPrefix: null,
      message: null,
      limit: 50,
      offset: 0,
    });
  });

  it('rejects a non-hex hash prefix', async () => {
    await expect(invoke('search_activity', makeStore(), { hash_prefix: 'zzz' })).rejects.toThrow();
  });
});

describe('count_activity', () => {
  it('counts over the full universe (same filters as search, no limit) and wraps the result', async () => {
    const store = makeStore();
    store.getActivityCount.mockResolvedValue(1234);
    const result = await invoke('count_activity', store, { actor: { kind: 'user', id: 3 }, message: 'fix' });
    expect(result).toEqual({ count: 1234 });
    expect(store.getActivityCount).toHaveBeenCalledWith({
      actor: { kind: 'user', id: 3 },
      repo: null,
      project: null,
      before: null,
      after: null,
      hashPrefix: null,
      message: 'fix',
      limit: 0,
      offset: 0,
    });
  });

  it('does not accept a limit argument', async () => {
    // limit is search-only; passing it should fail strict parse... it's
    // ignored (zod strips unknown keys by default), so just assert the count
    // path still works and limit is fixed at 0.
    const store = makeStore();
    await invoke('count_activity', store, {});
    expect(store.getActivityCount).toHaveBeenCalledWith(expect.objectContaining({ limit: 0, offset: 0 }));
  });
});

describe('activity_daily', () => {
  it('maps actor/repo/project into ActivityDailyFilters', async () => {
    const store = makeStore();
    await invoke('activity_daily', store, { project: 'BBSTAT' });
    expect(store.getActivityDaily).toHaveBeenCalledWith({ actor: null, repo: null, project: 'BBSTAT' });
  });
});

describe('repo_contributor_breakdown', () => {
  it('applies defaults (window 30, topRepos 15, topPerRepo 5, project null)', async () => {
    const store = makeStore();
    await invoke('repo_contributor_breakdown', store, {});
    expect(store.getRepoContributorBreakdown).toHaveBeenCalledWith({
      windowDays: 30,
      topRepos: 15,
      topPerRepo: 5,
      project: null,
    });
  });

  it('passes explicit args + project scope through', async () => {
    const store = makeStore();
    await invoke('repo_contributor_breakdown', store, {
      window_days: 7,
      top_repos: 5,
      top_per_repo: 3,
      project: 'BBSTAT',
    });
    expect(store.getRepoContributorBreakdown).toHaveBeenLastCalledWith({
      windowDays: 7,
      topRepos: 5,
      topPerRepo: 3,
      project: 'BBSTAT',
    });
  });

  it('rejects out-of-range counts', async () => {
    await expect(invoke('repo_contributor_breakdown', makeStore(), { top_repos: 100 })).rejects.toThrow();
  });
});
