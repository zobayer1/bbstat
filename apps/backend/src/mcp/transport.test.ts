import Fastify from 'fastify';
import pino from 'pino';
import { describe, it, expect } from 'vitest';
import type { StatsStore } from '../dashboard/stats-store.js';
import { signToken } from './auth.js';
import { mcpPlugin } from './transport.js';

const SECRET = 'transport-test-secret';
const logger = pino({ level: 'silent' });
// The auth-fail paths return before any store access, so an empty stub is fine.
const store = {} as StatsStore;

async function buildApp() {
  const app = Fastify({ loggerInstance: logger });
  await app.register(mcpPlugin, { store, secret: SECRET, logger });
  return app;
}

describe('mcpPlugin — auth gate + method routing', () => {
  it('serves /healthz without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('401s a POST with no bearer token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    await app.close();
  });

  // GET / DELETE must be ROUTED to the transport (not Fastify's default 404),
  // else streamable-HTTP clients that probe the GET SSE stream read the
  // endpoint as broken. The bearer gate runs first, so no-token GET/DELETE
  // return 401 — which proves the route exists (a 404 would mean it doesn't).
  it('routes GET /mcp through the auth gate (401, not 404)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('routes DELETE /mcp through the auth gate (401, not 404)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401s an invalid bearer token', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer v1.garbage.sig' },
      payload: { jsonrpc: '2.0' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401s an expired token (valid signature, past exp)', async () => {
    const app = await buildApp();
    // iat in the distant past, 1s ttl → long expired by now.
    const token = signToken(SECRET, { consumer: 'old', iat: 1_000_000_000, ttlSeconds: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
