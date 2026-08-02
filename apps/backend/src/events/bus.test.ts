import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './bus.js';

describe('createEventBus', () => {
  it('delivers published events to every subscriber', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.publish({
      event: 'repository.deleted',
      payload: { repositoryId: 1, fullName: 'acme/r' },
    });

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(a.mock.calls[0]?.[0]).toEqual({
      event: 'repository.deleted',
      payload: { repositoryId: 1, fullName: 'acme/r' },
    });
  });

  it('returns an unsubscribe function that stops further delivery', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe(handler);

    bus.publish({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a' } });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.publish({ event: 'repository.deleted', payload: { repositoryId: 2, fullName: 'b' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates handlers that throw — other subscribers still receive the event', () => {
    const bus = createEventBus();
    const broken = vi.fn(() => {
      throw new Error('boom');
    });
    const ok = vi.fn();
    bus.subscribe(broken);
    bus.subscribe(ok);

    bus.publish({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a' } });

    expect(broken).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
  });

  it('handles unsubscribe during publish (snapshot semantics)', () => {
    const bus = createEventBus();
    let unsub2: (() => void) | null = null;
    const a = vi.fn(() => {
      // Unsubscribe `b` from inside `a`'s handler. The snapshot must
      // still deliver to `b` for this event.
      unsub2?.();
    });
    const b = vi.fn();
    bus.subscribe(a);
    unsub2 = bus.subscribe(b);

    bus.publish({ event: 'repository.deleted', payload: { repositoryId: 1, fullName: 'a' } });
    expect(b).toHaveBeenCalledOnce();

    // Next publish: `b` is gone.
    bus.publish({ event: 'repository.deleted', payload: { repositoryId: 2, fullName: 'b' } });
    expect(b).toHaveBeenCalledOnce();
  });

  it('subscriberCount reflects subscribe / unsubscribe', () => {
    const bus = createEventBus();
    expect(bus.subscriberCount()).toBe(0);
    const u = bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(2);
    u();
    expect(bus.subscriberCount()).toBe(1);
  });
});
