// Boot-time check that wipes stale persisted Pinia state from localStorage
// when the in-code CACHE_VERSION doesn't match the sentinel key. MUST run
// before any Pinia store hydrates (before `app.mount` in main.ts) — otherwise
// stores read the old shape into memory and only the next reload's bust fixes
// it, defeating the automation.
//
// The wipe is scoped to `bbstat-` prefixed keys so we don't nuke anything else
// this origin stores. Non-prefixed legacy keys are orphaned on first boot
// (acceptable — same outcome as a version bump).

import { CACHE_VERSION, STORE_KEY_PREFIX, VERSION_SENTINEL_KEY } from './cache-version.js';

export function bustStaleCacheIfNeeded(): void {
  try {
    const stored = localStorage.getItem(VERSION_SENTINEL_KEY);
    const current = String(CACHE_VERSION);
    if (stored === current) return;
    // Walk backwards because removeItem shifts the index. `localStorage.key`
    // is index-based, so a forward loop would skip every other entry as
    // the list shrinks under us.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(STORE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem(VERSION_SENTINEL_KEY, current);
  } catch {
    // Private-browsing / disabled-storage / quota-exceeded — silent no-op.
    // The app works without persistence; re-throwing would block the whole
    // boot for a non-critical concern.
  }
}
