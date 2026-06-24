// Server-Sent Events endpoint for the dashboard live updates surface.
// Event catalog: src/events/bus.ts; protocol overview: docs/sync.md.
//
// Connection mechanics:
//   - `retry: 5000\n\n` at open so browser reconnects wait 5s
//     (defeats hot-restart loops during deploy).
//   - `: keepalive\n\n` every 25s — defeats reverse-proxy idle timeouts
//     (most default to 60s) and lets the browser detect a dead TCP
//     connection via the next read failure.

import type { FastifyPluginAsync } from 'fastify';
import type { EventBus, LiveEvent } from '../events/bus.js';

export interface LiveRouteOptions {
  bus: EventBus;
  // Default 25s — under the typical 60s proxy idle timeout.
  keepAliveIntervalMs?: number;
}

export const liveRoutes: FastifyPluginAsync<LiveRouteOptions> = async (app, opts) => {
  const keepAliveMs = opts.keepAliveIntervalMs ?? 25_000;

  app.get('/live', async (request, reply) => {
    const connectionId = Math.random().toString(36).slice(2, 10);
    app.log.info({ connectionId, remote: request.ip }, 'live: SSE connection opened');

    // `Connection: keep-alive` set explicitly because some proxies look for
    // it before streaming the response unchunked.
    //
    // CORS: writing through reply.raw bypasses Fastify's onSend hook (where
    // @fastify/cors would inject Access-Control-Allow-Origin), so set CORS
    // headers manually here, mirroring app.ts (`origin: true`). Echo the
    // request Origin with `Vary: Origin` for cache correctness.
    const origin = request.headers.origin;
    const corsHeaders: Record<string, string> =
      typeof origin === 'string' && origin.length > 0 ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable nginx-style buffering — see
      // https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    });

    // Browser reconnect interval. SSE clients honor this on disconnect.
    reply.raw.write('retry: 5000\n\n');

    // Single cleanup path for every disconnect/error route below. Idempotent.
    let disposed = false;
    const dispose = (reason: string): void => {
      if (disposed) return;
      disposed = true;
      app.log.info({ connectionId, reason }, 'live: SSE connection closed');
      clearInterval(keepAliveTimer);
      unsubscribe();
    };

    // `destroyed` flips true the moment the socket is torn down — before our
    // 'close' handler fires on TLS error / client RST. Skip writes that would
    // otherwise emit an unhandled 'error' on a dead socket.
    const isAlive = (): boolean => !reply.raw.destroyed && !reply.raw.writableEnded;

    const writeEvent = (event: LiveEvent): void => {
      if (!isAlive()) {
        dispose('write to dead socket');
        return;
      }
      try {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      } catch (err) {
        app.log.warn(
          { connectionId, err: err instanceof Error ? err.message : String(err) },
          'live: event write threw',
        );
        dispose('event write threw');
      }
    };

    const unsubscribe = opts.bus.subscribe(writeEvent);

    const keepAliveTimer = setInterval(() => {
      if (!isAlive()) {
        dispose('keepalive on dead socket');
        return;
      }
      try {
        reply.raw.write(`: keepalive ${Date.now()}\n\n`);
      } catch (err) {
        app.log.warn(
          { connectionId, err: err instanceof Error ? err.message : String(err) },
          'live: keepalive write threw',
        );
        dispose('keepalive write threw');
      }
    }, keepAliveMs);

    // Socket 'error' fires on TLS hiccups / kernel-buffer overflows / client
    // RST: without a listener, Node would crash the process.
    request.raw.on('close', () => dispose('request raw close'));
    reply.raw.on('close', () => dispose('reply raw close'));
    reply.raw.on('error', (err: Error) => {
      app.log.warn({ connectionId, err: err.message }, 'live: reply stream error');
      dispose('reply error');
    });
    request.raw.on('error', (err: Error) => {
      app.log.warn({ connectionId, err: err.message }, 'live: request stream error');
      dispose('request error');
    });

    // Never-resolving promise keeps Fastify from sending its own
    // end-of-response; the handler stays until socket close fires above.
    return new Promise<void>(() => {
      /* intentionally never resolves */
    });
  });
};
