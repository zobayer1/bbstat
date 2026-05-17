// Boot-time check that wipes stale persisted Pinia state from localStorage
// when the in-code CACHE_VERSION doesn't match the value last written to
// the sentinel key. Must run BEFORE any Pinia store hydrates (i.e. before
// `app.mount` in main.ts), otherwise stores would read the old shape into
// memory and the bust on the next reload would be the only thing that
// fixes things — defeating the point of automating this.
//
// The wipe is scoped to `bbstat-` prefixed keys so we don't nuke anything
// else this origin might be storing. The plugin in src/stores/index.ts
// applies the prefix globally; any non-prefixed legacy keys from before
// this change are orphaned on first boot (acceptable — same outcome as a
// version bump).

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
    // Private-browsing / disabled-storage / quota-exceeded — silent no-op
    // is the right call: the app still works without persistence, and
    // re-throwing here would just block the entire boot for a non-critical
    // background concern.
  }
}
