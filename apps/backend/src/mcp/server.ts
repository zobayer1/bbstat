// Builds the MCP server object: adapts each framework-agnostic ToolDef from the
// registry into an SDK registerTool call. The ONLY place the MCP SDK meets our
// tool layer.
//
// Built per request in the stateless HTTP transport (see transport.ts) and once
// per test — so it must stay cheap and side-effect free beyond registration.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { StatsStore } from '../dashboard/stats-store.js';
import { tools } from './tools/registry.js';
import { ToolError } from './tools/types.js';

export const MCP_SERVER_INFO = { name: 'bbstat', version: '0.1.0' } as const;

const INSTRUCTIONS = [
  'Read-only access to the bbstat (ShipShow!) BitBucket contribution dashboard.',
  'All data is served from bbstat’s own store — these tools never call BitBucket live.',
  'Resolve people before fetching their detail: use list_members or top_contributors to get an entity_kind + entity_id, then get_contributor_summary. Resolve repositories via list_repositories (workspace + slug) before get_repository_activity. Do not guess internal numeric ids.',
].join(' ');

export function buildMcpServer(store: StatsStore, logger: Logger): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        // Every tool is a pure read — advertise so hosts treat them as safe.
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        try {
          const data = await tool.handler(store, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          // Expected, user-facing failures come back as a clean isError result
          // the agent can read and recover from.
          if (err instanceof ToolError) {
            return { content: [{ type: 'text' as const, text: err.message }], isError: true };
          }
          // Anything else is an internal fault: log it, mask the detail.
          logger.error(
            { tool: tool.name, err: err instanceof Error ? err.message : String(err) },
            'mcp tool execution failed',
          );
          return {
            content: [{ type: 'text' as const, text: `Internal error executing ${tool.name}.` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
