// SSE route test. inject() doesn't stream, so we boot Fastify on a
// random port and use fetch + a stream reader to read raw frames.

import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createEventBus } from '../events/bus.js';
import { liveRoutes } from './live.js';

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
  bus: ReturnType<typeof createEventBus>;
}

async function start(keepAliveIntervalMs = 25_000): Promise<ServerHandle> {
  const app = Fastify({ logger: false });
  const bus = createEventBus();
  await app.register(liveRoutes, { prefix: '/api', bus, keepAliveIntervalMs });
  // 127.0.0.1:0 lets the OS pick a free port. address() returns the bound info.
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url: typeof address === 'string' ? address : `http://127.0.0.1:${(address as { port: number }).port}`,
    close: async () => {
      await app.close();
    },
    bus,
  };
}

// Reads bytes from the stream until `predicate(buf)` returns true, then
// resolves the accumulated string. Times out at `timeoutMs` to keep a
// hung test from blocking the whole suite.
async function readUntil(
  body: ReadableStream<Uint8Array> | null,
  predicate: (acc: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  if (body === null) throw new Error('response body is null');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (predicate(acc)) {
      void reader.cancel();
      return acc;
    }
  }
  void reader.cancel();
  throw new Error(`readUntil timed out after ${timeoutMs}ms — accumulated:\n${acc}`);
}

describe('GET /api/live', () => {
  let server: ServerHandle | null = null;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('opens with SSE headers + retry directive', async () => {
    server = await start();
    const res = await fetch(`${server.url}/api/live`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');

    // The retry directive lands in the very first bytes.
    const buf = await readUntil(res.body, (s) => s.includes('retry:'));
    expect(buf).toContain('retry: 5000');
  });

  it('echoes the request Origin in Access-Control-Allow-Origin (cross-origin EventSource)', async () => {
    server = await start();
    const res = await fetch(`${server.url}/api/live`, {
      headers: { Origin: 'https://bbstat.localhost:5173' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('https://bbstat.localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
    void res.body?.cancel();
  });

  it('writes a frame per published event', async () => {
    server = await start();
    const res = await fetch(`${server.url}/api/live`);
    // Drain the retry prefix before publishing.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    const readMore = async (): Promise<void> => {
      const { value } = await reader.read();
      acc += decoder.decode(value, { stream: true });
    };
    await readMore();

    server.bus.publish({
      event: 'repository.deleted',
      payload: { repositoryId: 42, fullName: 'tigerit/doomed' },
    });

    // Wait until the event frame shows up — single iteration is enough
    // for in-process publish, but loop defensively to avoid flakes.
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && !acc.includes('event: repository.deleted')) {
      await readMore();
    }
    void reader.cancel();

    expect(acc).toContain('event: repository.deleted');
    expect(acc).toContain('"repositoryId":42');
    expect(acc).toContain('"fullName":"tigerit/doomed"');
  });

  it('drops the subscriber when the client disconnects', async () => {
    server = await start();
    const ac = new AbortController();
    const res = await fetch(`${server.url}/api/live`, { signal: ac.signal });
    // Read at least one chunk so the connection is firmly established.
    const reader = res.body!.getReader();
    await reader.read();

    // Pre-disconnect: one subscriber.
    expect(server.bus.subscriberCount()).toBe(1);

    ac.abort();
    void reader.cancel().catch(() => {});

    // Allow the 'close' handler to fire.
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && server.bus.subscriberCount() > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(server.bus.subscriberCount()).toBe(0);
  });

  it('sends keep-alive comments on a short interval', async () => {
    server = await start(50); // 50ms — fast enough for a test
    const res = await fetch(`${server.url}/api/live`);
    const buf = await readUntil(res.body, (s) => s.includes(': keepalive'));
    expect(buf).toContain(': keepalive');
  });
});
