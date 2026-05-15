// In-memory fake Redis pub/sub — the tests don't need a real connection,
// just the publish/subscribe shape the bridge consumes.

import { describe, expect, it, vi } from 'vitest';
import { createEventBus, type LiveEvent } from './bus.js';
import { REDIS_EVENT_CHANNEL, wrapBusWithRedis, type RedisLike } from './redis-bridge.js';

// One in-memory "Redis instance" shared across cloned clients via the
// `world` object — duplicate() shares the same world so a publish from
// one connection reaches subscribers on another.
interface World {
  listeners: Map<string, Set<(channel: string, message: string) => void>>;
}

function createWorld(): World {
  return { listeners: new Map() };
}

function createFakeRedis(world: World): RedisLike {
  const subscribedChannels = new Set<string>();
  const onMessageHandlers = new Set<(channel: string, message: string) => void>();
  return {
    async publish(channel: string, message: string): Promise<number> {
      const targets = world.listeners.get(channel);
      if (targets === undefined) return 0;
      for (const t of [...targets]) t(channel, message);
      return targets.size;
    },
    duplicate(): RedisLike {
      return createFakeRedis(world);
    },
    async subscribe(channel: string): Promise<unknown> {
      subscribedChannels.add(channel);
      let bucket = world.listeners.get(channel);
      if (bucket === undefined) {
        bucket = new Set();
        world.listeners.set(channel, bucket);
      }
      // Every queued onMessage handler on this connection becomes a
      // listener on the shared world.
      for (const h of onMessageHandlers) bucket.add(h);
      return 1;
    },
    on(event, listener): unknown {
      if (event === 'message') {
        onMessageHandlers.add(listener as (channel: string, message: string) => void);
        // Apply retroactively to channels subscribed before `on('message')` was wired.
        for (const ch of subscribedChannels) {
          world.listeners.get(ch)?.add(listener as (channel: string, message: string) => void);
        }
      }
      return undefined;
    },
    async quit(): Promise<unknown> {
      for (const ch of subscribedChannels) {
        const bucket = world.listeners.get(ch);
        for (const h of onMessageHandlers) bucket?.delete(h);
      }
      return 'OK';
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('wrapBusWithRedis', () => {
  it('delivers locally-published events to local subscribers without a Redis round-trip', async () => {
    const world = createWorld();
    const localBus = createEventBus();
    const bridge = await wrapBusWithRedis(localBus, createFakeRedis(world), { sourceId: 'A' });

    const seen: LiveEvent[] = [];
    bridge.subscribe((e) => seen.push(e));

    bridge.publish({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a/b' } });

    // No await needed — local delivery is synchronous.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a/b' } });

    await bridge.dispose();
  });

  it('fans out a publish from one process to subscribers in another', async () => {
    const world = createWorld();
    const localBusA = createEventBus();
    const localBusB = createEventBus();
    const bridgeA = await wrapBusWithRedis(localBusA, createFakeRedis(world), { sourceId: 'A' });
    const bridgeB = await wrapBusWithRedis(localBusB, createFakeRedis(world), { sourceId: 'B' });

    const seenA: LiveEvent[] = [];
    const seenB: LiveEvent[] = [];
    bridgeA.subscribe((e) => seenA.push(e));
    bridgeB.subscribe((e) => seenB.push(e));

    bridgeA.publish({ event: 'repository.deleted', payload: { repositoryId: 42, fullName: 'tigerit/x' } });

    // Redis publish() is async — give the fake event loop a tick.
    await flushMicrotasks();

    // A sees it locally (synchronous), B sees it via the bridge.
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenB[0]).toEqual({ event: 'repository.deleted', payload: { repositoryId: 42, fullName: 'tigerit/x' } });

    await bridgeA.dispose();
    await bridgeB.dispose();
  });

  it('deduplicates self-published echoes — same-process subscribers see exactly one delivery', async () => {
    const world = createWorld();
    const localBus = createEventBus();
    const bridge = await wrapBusWithRedis(localBus, createFakeRedis(world), { sourceId: 'A' });

    const seen: LiveEvent[] = [];
    bridge.subscribe((e) => seen.push(e));

    bridge.publish({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a/b' } });

    // Even after Redis round-trip completes, the matching sourceId
    // causes the echo to be dropped.
    await flushMicrotasks();
    expect(seen).toHaveLength(1);

    await bridge.dispose();
  });

  it('ignores malformed envelopes — bridge stays alive, well-formed events still flow', async () => {
    const world = createWorld();
    const localBus = createEventBus();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const bridge = await wrapBusWithRedis(localBus, createFakeRedis(world), {
      sourceId: 'A',
      logger,
    });

    const seen: LiveEvent[] = [];
    bridge.subscribe((e) => seen.push(e));

    // Manually fan out a bogus message via the fake's world bus.
    for (const h of world.listeners.get(REDIS_EVENT_CHANNEL) ?? []) {
      h(REDIS_EVENT_CHANNEL, 'not json at all');
    }

    expect(logger.warn).toHaveBeenCalled();
    expect(seen).toHaveLength(0);

    // Subsequent legitimate event still arrives.
    const bridge2 = await wrapBusWithRedis(createEventBus(), createFakeRedis(world), { sourceId: 'B' });
    bridge2.publish({ event: 'repository.deleted', payload: { repositoryId: 5, fullName: 'a/b' } });
    await flushMicrotasks();
    expect(seen).toHaveLength(1);

    await bridge.dispose();
    await bridge2.dispose();
  });

  it('publisher errors on the Redis side do not break in-process delivery', async () => {
    const world = createWorld();
    const localBus = createEventBus();
    const broken: RedisLike = {
      ...createFakeRedis(world),
      async publish(): Promise<number> {
        throw new Error('redis down');
      },
    };
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const bridge = await wrapBusWithRedis(localBus, broken, {
      sourceId: 'A',
      logger,
    });

    const seen: LiveEvent[] = [];
    bridge.subscribe((e) => seen.push(e));

    bridge.publish({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a/b' } });
    await flushMicrotasks();

    expect(seen).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();

    await bridge.dispose();
  });
});
