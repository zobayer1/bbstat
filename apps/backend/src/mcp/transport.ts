// Fastify plugin wiring the MCP server: a bearer-gated POST <path> that speaks
// streamable-HTTP, plus an unauthenticated /healthz for container probes.
//
// Registered via `app.register(mcpPlugin, opts)` (like the dashboard's route
// plugins) so the plugin sees the default FastifyInstance regardless of how
// the root app specialised its logger type.
//
// Stateless transport: a fresh McpServer + StreamableHTTPServerTransport are
// created PER REQUEST (sessionIdGenerator: undefined) so concurrent requests
// can't collide on JSON-RPC ids or share session state. enableJsonResponse
// makes each call a single JSON body rather than an SSE stream — all a
// read-only request/response tool surface needs. Fastify has already parsed
// the JSON body, so we hand it to handleRequest as the pre-parsed body and
// hijack the reply to let the transport own the raw socket.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { StatsStore } from '../dashboard/stats-store.js';
import { extractBearer, verifyToken } from './auth.js';
import { buildMcpServer } from './server.js';

export interface McpPluginOptions {
  store: StatsStore;
  // HMAC key for bearer verification (config.MCP_TOKEN_SECRET, already
  // guaranteed present by the entrypoint).
  secret: string;
  logger: Logger;
  // Endpoint path. Defaults to '/mcp'.
  path?: string;
}

function unauthorized(message: string): { jsonrpc: '2.0'; error: { code: number; message: string }; id: null } {
  // JSON-RPC-shaped error body so MCP clients surface a meaningful message
  // alongside the 401 status.
  return { jsonrpc: '2.0', error: { code: -32001, message }, id: null };
}

export const mcpPlugin: FastifyPluginAsync<McpPluginOptions> = async (app, opts) => {
  const path = opts.path ?? '/mcp';

  app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Shared handler for every method on the MCP endpoint. Streamable-HTTP
  // clients hit this with POST (JSON-RPC requests), GET (open the server→client
  // SSE stream), and DELETE (terminate a session). All three must reach the
  // SDK transport so it returns the protocol-correct response — routing only
  // POST would make Fastify answer GET/DELETE with a 404, which clients read as
  // a broken endpoint and refuse to connect. In stateless mode the transport
  // answers GET/DELETE with 405, which is the right "no standalone stream"
  // signal.
  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = extractBearer(request.headers.authorization);
    if (token === null) {
      await reply.code(401).header('WWW-Authenticate', 'Bearer').send(unauthorized('Missing bearer token.'));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const verdict = verifyToken(opts.secret, token, now);
    if (!verdict.ok) {
      opts.logger.warn({ reason: verdict.reason }, 'mcp: rejected token');
      await reply.code(401).header('WWW-Authenticate', 'Bearer').send(unauthorized('Invalid or expired bearer token.'));
      return;
    }
    opts.logger.debug({ consumer: verdict.payload.consumer, method: request.method }, 'mcp: authorized request');

    const server = buildMcpServer(opts.store, opts.logger);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // Free both when the client disconnects / the response finishes. Swallow
    // rejections so a teardown error on an abrupt disconnect never surfaces as
    // an unhandled rejection (which would crash the process).
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    // Fastify must not also try to send — the transport writes to the raw res.
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      opts.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'mcp: request handling failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error.' }, id: null }),
        );
      }
    }
  };

  app.post(path, handle);
  app.get(path, handle);
  app.delete(path, handle);
};
