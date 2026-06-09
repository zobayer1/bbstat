import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { describe, it, expect, vi } from 'vitest';
import type { StatsStore } from '../dashboard/stats-store.js';
import { buildMcpServer } from './server.js';

const silentLogger = pino({ level: 'silent' });
const OVERVIEW = { totalRepositories: 42, totalCommits: 1234 };

function makeStore() {
  return {
    getOverview: vi.fn(async () => OVERVIEW),
    getLatestCommitForRepository: vi.fn(async () => null),
    getTopContributors: vi.fn(async () => [{ entityKind: 'user', entityId: 1, displayName: 'Ada', commits: 9 }]),
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

// Stand up a real MCP Client linked to our server over the in-memory
// transport — no network, no DB, exercises the full SDK register/list/call
// path against the fake store.
async function connect(store = makeStore()) {
  const server = buildMcpServer(store as unknown as StatsStore, silentLogger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, store };
}

// Tool call results carry content as an array of typed parts; pull the first
// text part out for assertions.
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0];
  if (!part || part.type !== 'text' || part.text === undefined) {
    throw new Error('expected a text content part');
  }
  return part.text;
}

describe('buildMcpServer', () => {
  it('registers every tool as read-only with a description', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'activity_daily',
        'get_contributor_summary',
        'get_overview',
        'get_project_stats',
        'get_repository_activity',
        'list_members',
        'list_repositories',
        'search_activity',
        'top_contributors',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(20);
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('returns tool output as JSON text content', async () => {
    const { client, store } = await connect();
    const result = await client.callTool({ name: 'get_overview', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result as never))).toEqual(OVERVIEW);
    expect(store.getOverview).toHaveBeenCalledOnce();
  });

  it('passes validated arguments through to the handler', async () => {
    const { client, store } = await connect();
    await client.callTool({ name: 'top_contributors', arguments: { window_days: 7, limit: 3 } });
    expect(store.getTopContributors).toHaveBeenCalledWith(7, 3);
  });

  it('maps a ToolError (unknown id) to an isError result, not a transport failure', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'get_contributor_summary',
      arguments: { entity_kind: 'person', entity_id: 999 },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result as never)).toMatch(/No person found with id 999/);
  });

  it('does not let schema-violating arguments reach the store', async () => {
    const { client, store } = await connect();
    // window_days below the minimum. The SDK validates inputSchema before the
    // handler runs — surfaced either as a rejected call or an isError result,
    // depending on SDK version. Either way the handler must not be invoked.
    const outcome = await client
      .callTool({ name: 'top_contributors', arguments: { window_days: 0 } })
      .then((result) => ({ rejected: false, isError: Boolean(result.isError) }))
      .catch(() => ({ rejected: true, isError: true }));
    expect(outcome.isError).toBe(true);
    expect(store.getTopContributors).not.toHaveBeenCalled();
  });
});
