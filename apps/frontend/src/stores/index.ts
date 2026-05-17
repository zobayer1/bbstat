import { createPinia } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import { STORE_KEY_PREFIX } from '@/lib/cache-version';

// Every persisted store writes to a `bbstat-<id>` localStorage key so the
// boot-time bust (`bustStaleCacheIfNeeded` in lib/cache-bust.ts) can
// reliably find and wipe our state without touching anything else this
// origin might be storing. New stores auto-participate — no manual key
// configuration per store.
export function createStore() {
  const pinia = createPinia();
  pinia.use(createPersistedState({ key: (id) => `${STORE_KEY_PREFIX}${id}` }));
  return pinia;
}
