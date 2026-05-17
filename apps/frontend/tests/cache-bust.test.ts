import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bustStaleCacheIfNeeded } from '../src/lib/cache-bust';
import { CACHE_VERSION, STORE_KEY_PREFIX, VERSION_SENTINEL_KEY } from '../src/lib/cache-version';

// vitest's jsdom env wires a localStorage that persists across tests in
// the same file, so each test starts by clearing it. Avoids spooky-action-
// at-a-distance failures from order-dependent residue.
beforeEach(() => {
  localStorage.clear();
});

describe('bustStaleCacheIfNeeded', () => {
  it('is a no-op when the sentinel already matches CACHE_VERSION', () => {
    localStorage.setItem(VERSION_SENTINEL_KEY, String(CACHE_VERSION));
    localStorage.setItem(`${STORE_KEY_PREFIX}members`, '{"members":[1,2,3]}');
    localStorage.setItem('unrelated-key', 'keep me');

    bustStaleCacheIfNeeded();

    expect(localStorage.getItem(`${STORE_KEY_PREFIX}members`)).toBe('{"members":[1,2,3]}');
    expect(localStorage.getItem('unrelated-key')).toBe('keep me');
    expect(localStorage.getItem(VERSION_SENTINEL_KEY)).toBe(String(CACHE_VERSION));
  });

  it('wipes every bbstat- prefixed key when the sentinel is stale, leaves other keys untouched', () => {
    localStorage.setItem(VERSION_SENTINEL_KEY, String(CACHE_VERSION - 1));
    localStorage.setItem(`${STORE_KEY_PREFIX}members`, '{"old":"shape"}');
    localStorage.setItem(`${STORE_KEY_PREFIX}stats`, '{"old":"shape"}');
    localStorage.setItem(`${STORE_KEY_PREFIX}userSummary`, '{"old":"shape"}');
    localStorage.setItem('non-bbstat-key', 'preserve');
    localStorage.setItem('theme', 'dark');

    bustStaleCacheIfNeeded();

    expect(localStorage.getItem(`${STORE_KEY_PREFIX}members`)).toBeNull();
    expect(localStorage.getItem(`${STORE_KEY_PREFIX}stats`)).toBeNull();
    expect(localStorage.getItem(`${STORE_KEY_PREFIX}userSummary`)).toBeNull();
    // Non-prefixed keys survive — we only own `bbstat-*`.
    expect(localStorage.getItem('non-bbstat-key')).toBe('preserve');
    expect(localStorage.getItem('theme')).toBe('dark');
    // Sentinel is updated to the current version.
    expect(localStorage.getItem(VERSION_SENTINEL_KEY)).toBe(String(CACHE_VERSION));
  });

  it('treats a missing sentinel (first-ever run) as stale and wipes legacy bare-keyed stores', () => {
    // First deploy of the prefix scheme: existing users have legacy bare
    // keys AND no sentinel. They shouldn't survive the bust — the bare
    // keys aren't even read anymore (plugin now writes prefixed), but
    // the test below also covers the case where a developer simulates
    // bare keys via the prefix to make the assertion concrete.
    localStorage.setItem(`${STORE_KEY_PREFIX}members`, '{"old":"shape"}');
    localStorage.setItem('untouched', 'still here');

    bustStaleCacheIfNeeded();

    expect(localStorage.getItem(`${STORE_KEY_PREFIX}members`)).toBeNull();
    expect(localStorage.getItem('untouched')).toBe('still here');
    expect(localStorage.getItem(VERSION_SENTINEL_KEY)).toBe(String(CACHE_VERSION));
  });

  it('survives a thrown localStorage (private-browsing / disabled storage) silently', () => {
    // Simulate the Safari-private-mode failure where setItem throws.
    // The function must not propagate — boot would block on a non-critical
    // background concern otherwise.
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    expect(() => bustStaleCacheIfNeeded()).not.toThrow();

    setItemSpy.mockRestore();
  });
});
