// Server-Sent Events endpoint for the dashboard live updates surface.
// Browsers open one `new EventSource('/api/live')` per tab; the backend
// keeps the response stream open and writes `event:` / `data:` frames as
// the in-process event bus fires. See src/events/bus.ts for the event
// catalog; see docs/sync.md "Live updates" for the protocol overview.
//
// Connection mechanics:
//   - `retry: 5000\n\n` at open so browser-automatic reconnects wait
//     5s before retry (defeats hot-restart loops during deploy).
//   - `: keepalive\n\n` every 25s — defeats reverse-proxy idle timeouts
//     (most default to 60s) and lets the browser detect a dead TCP
//     connection via the next read failure.
//   - Subscriber is dropped when the underlying socket closes
//     (`request.raw.on('close', ...)`); no manual cleanup needed in the
//     route handler.

import type { FastifyPluginAsync } from 'fastify';
import type { EventBus, LiveEvent } from '../events/bus.js';

export interface LiveRouteOptions {
  bus: EventBus;
  // Seconds between keep-alive comments. Default 25s — under the
  // typical 60s proxy idle timeout. Exposed for tests that need a
  // shorter interval to verify the timer actually fires.
  keepAliveIntervalMs?: number;
}

export const liveRoutes: FastifyPluginAsync<LiveRouteOptions> = async (app, opts) => {
  const keepAliveMs = opts.keepAliveIntervalMs ?? 25_000;

  app.get('/live', async (request, reply) => {
    const connectionId = Math.random().toString(36).slice(2, 10);
    app.log.info({ connectionId, remote: request.ip }, 'live: SSE connection opened');

    // SSE headers. `Connection: keep-alive` is the HTTP/1.1 default but
    // we set it explicitly because some proxies look for it before
    // letting the response stream through unchunked.
    //
    // CORS: writing through reply.raw bypasses Fastify's onSend hook
    // (where @fastify/cors would normally inject the
    // Access-Control-Allow-Origin header), so we set CORS headers
    // manually here. Mirrors the plugin's config in app.ts
    // (`origin: true, credentials: false`): echo the request's Origin
    // so cross-origin EventSource clients (e.g., dev frontend at :5173
    // hitting the backend at :8443) are not rejected by the browser's
    // CORS check. The `Vary: Origin` response header is the cache-
    // correctness companion when echoing.
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

    // Single cleanup path — invoked by every disconnect / error route
    // below. Idempotent: calling twice is a no-op past the first.
    let disposed = false;
    const dispose = (reason: string): void => {
      if (disposed) return;
      disposed = true;
      app.log.info({ connectionId, reason }, 'live: SSE connection closed');
      clearInterval(keepAliveTimer);
      unsubscribe();
    };

    // `destroyed` flips true the moment the underlying socket is
    // closed/torn down — before our 'close' handler fires, in the
    // case of a TLS error or RST from the client. Skip writes that
    // would otherwise emit an unhandled 'error' on a dead socket.
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

    // Cleanup triggers — any one of these unwinds the subscriber + timer.
    // Socket 'error' fires on TLS hiccups / kernel-buffer overflows /
    // client RST: without a listener, Node would crash the process.
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

    // Returning a never-resolving promise keeps Fastify from sending
    // its own end-of-response. The handler "stays" until the socket
    // close fires above.
    return new Promise<void>(() => {
      /* intentionally never resolves */
    });
  });
};
