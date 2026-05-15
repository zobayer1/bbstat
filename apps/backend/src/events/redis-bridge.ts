// Cross-process bridge for the live updates EventBus. The HTTPS API and
// the cron host run as separate Node processes; their in-memory buses
// can't see each other, so cron-triggered events would never reach the
// SSE subscribers in the API process. The bridge wraps a local bus
// with a Redis pub/sub fan-out:
//
//   * publish(event) → deliver to local subscribers immediately
//                      (zero latency for in-process consumers)
//                    + write `{ sourceId, event }` to the
//                      `bbstat:events` Redis channel
//
//   * Redis subscriber → deserialize, drop if `sourceId === ours`
//                       (we already delivered locally), else
//                       deliver to local subscribers
//
// Each process generates a random `sourceId` at startup so the dedupe
// check stays correct across reconnects. The bridge needs a dedicated
// Redis connection for subscribe mode (ioredis can't multiplex regular
// commands on a subscribed connection); we `.duplicate()` an existing
// client rather than asking callers to wire two.
//
// If multi-instance backend deploy ever happens, this same bridge
// handles fan-out between replicas — no further work needed.

import { randomUUID } from 'node:crypto';
import type { BitbucketLogger } from '../bitbucket/client.js';
import type { EventBus, LiveEvent } from './bus.js';

export const REDIS_EVENT_CHANNEL = 'bbstat:events';

// Minimum surface of ioredis that the bridge needs. Typed as a small
// interface so tests can pass an in-memory fake without pulling in
// ioredis itself.
export interface RedisLike {
  publish(channel: string, message: string): Promise<number> | number;
  duplicate(): RedisLike;
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  quit(): Promise<unknown>;
}

interface Envelope {
  v: 1;
  sourceId: string;
  event: LiveEvent['event'];
  payload: unknown;
}

export interface RedisBridgedBus extends EventBus {
  // Identity of this process on the bus. Exposed for tests / observability;
  // production code shouldn't need to read it.
  readonly sourceId: string;
  // Close the dedicated subscriber connection. Call on graceful shutdown
  // so the Redis client doesn't keep the event loop alive.
  dispose(): Promise<void>;
}

export interface WrapBusWithRedisOptions {
  logger?: BitbucketLogger;
  // Override the per-process sourceId. Tests use this to assert the
  // dedupe path; production leaves it auto-generated.
  sourceId?: string;
}

export async function wrapBusWithRedis(
  localBus: EventBus,
  publisher: RedisLike,
  opts: WrapBusWithRedisOptions = {},
): Promise<RedisBridgedBus> {
  const sourceId = opts.sourceId ?? randomUUID();
  const logger = opts.logger;

  // Dedicated subscriber connection. ioredis enters subscribe mode on
  // the connection that calls `subscribe()` and refuses regular commands
  // there afterwards; .duplicate() clones the connection options into a
  // fresh client.
  const subscriber = publisher.duplicate();

  subscriber.on('error', (err: Error) => {
    logger?.warn?.({ err: err.message }, 'live: redis subscriber error — auto-reconnect will retry');
  });

  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== REDIS_EVENT_CHANNEL) return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(message) as Envelope;
    } catch (err) {
      logger?.warn?.(
        { err: err instanceof Error ? err.message : String(err), preview: message.slice(0, 80) },
        'live: dropping malformed envelope from redis',
      );
      return;
    }
    if (envelope.sourceId === sourceId) {
      // We published this locally; localBus.publish() already delivered
      // to in-process subscribers. Skip the round-trip echo.
      return;
    }
    // Trust the envelope shape — only our own publish() writes to this
    // channel. If a future contributor adds a new event variant they
    // own both ends.
    localBus.publish({ event: envelope.event, payload: envelope.payload } as LiveEvent);
  });

  await subscriber.subscribe(REDIS_EVENT_CHANNEL);

  return {
    sourceId,
    subscribe(s) {
      return localBus.subscribe(s);
    },
    publish(event) {
      // Local-first delivery: in-process subscribers see the event
      // synchronously with no Redis latency. The cross-process broadcast
      // chases asynchronously.
      localBus.publish(event);
      const envelope: Envelope = {
        v: 1,
        sourceId,
        event: event.event,
        payload: event.payload,
      };
      // publish() returns a promise we deliberately don't await — a slow
      // Redis call must not block the publishing path. Errors land in the
      // logger and life goes on.
      Promise.resolve(publisher.publish(REDIS_EVENT_CHANNEL, JSON.stringify(envelope))).catch((err) => {
        logger?.warn?.(
          { err: err instanceof Error ? err.message : String(err), event: event.event },
          'live: redis publish failed — in-process subscribers still received the event',
        );
      });
    },
    subscriberCount() {
      return localBus.subscriberCount();
    },
    async dispose() {
      await subscriber.quit();
    },
  };
}
