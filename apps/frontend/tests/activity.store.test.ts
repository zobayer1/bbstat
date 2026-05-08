import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useActivityStore } from '../src/stores/activity';

describe('activity store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts empty with no last sync', () => {
    const store = useActivityStore();
    expect(store.entries).toEqual([]);
    expect(store.lastSyncedAt).toBeNull();
  });

  it('setEntries updates entries and stamps lastSyncedAt', () => {
    const store = useActivityStore();
    store.setEntries([{ id: 'c1', actor: 'alice', action: 'push', occurredAt: '2026-05-08T00:00:00Z' }]);
    expect(store.entries).toHaveLength(1);
    expect(store.lastSyncedAt).not.toBeNull();
  });

  it('clear resets state', () => {
    const store = useActivityStore();
    store.setEntries([{ id: 'c1', actor: 'alice', action: 'push', occurredAt: '2026-05-08T00:00:00Z' }]);
    store.clear();
    expect(store.entries).toEqual([]);
    expect(store.lastSyncedAt).toBeNull();
  });
});
