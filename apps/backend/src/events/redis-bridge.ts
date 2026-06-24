// Cross-process bridge for the live-updates EventBus. The HTTPS API and the
// cron host are separate Node processes with separate in-memory buses, so
// cron-triggered events would never reach the API process's SSE subscribers.
// The bridge wraps a local bus with a Redis pub/sub fan-out: publish() delivers
// locally immediately AND writes to the `bbstat:events` channel; the Redis
// subscriber re-delivers locally, dropping envelopes with our own sourceId
// (already delivered). Each process generates a random sourceId at startup so
// dedupe survives reconnects. A dedicated `.duplicate()` connection is required
// for subscribe mode (ioredis can't multiplex commands on a subscribed conn).
// Also handles fan-out between replicas if a multi-instance deploy ever lands.

import { randomUUID } from 'node:crypto';
import type { BitbucketLogger } from '../bitbucket/client.js';
import type { EventBus, LiveEvent } from './bus.js';

export const REDIS_EVENT_CHANNEL = 'bbstat:events';

// Minimum ioredis surface the bridge needs, typed so tests can pass a fake.
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
  readonly sourceId: string;
  // Close the dedicated subscriber connection on graceful shutdown so the
  // Redis client doesn't keep the event loop alive.
  dispose(): Promise<void>;
}

export interface WrapBusWithRedisOptions {
  logger?: BitbucketLogger;
  // Override the per-process sourceId — tests use this to assert dedupe.
  sourceId?: string;
}

export async function wrapBusWithRedis(
  localBus: EventBus,
  publisher: RedisLike,
  opts: WrapBusWithRedisOptions = {},
): Promise<RedisBridgedBus> {
  const sourceId = opts.sourceId ?? randomUUID();
  const logger = opts.logger;

  // Dedicated subscriber connection: ioredis refuses regular commands on a
  // connection in subscribe mode, so clone a fresh client.
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
      // Already delivered locally by our own publish() — skip the echo.
      return;
    }
    // Trust the envelope shape — only our own publish() writes to this channel.
    localBus.publish({ event: envelope.event, payload: envelope.payload } as LiveEvent);
  });

  await subscriber.subscribe(REDIS_EVENT_CHANNEL);

  return {
    sourceId,
    subscribe(s) {
      return localBus.subscribe(s);
    },
    publish(event) {
      // Local-first: in-process subscribers see the event synchronously; the
      // cross-process broadcast chases asynchronously.
      localBus.publish(event);
      const envelope: Envelope = {
        v: 1,
        sourceId,
        event: event.event,
        payload: event.payload,
      };
      // Deliberately not awaited — a slow Redis call must not block publishing.
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
