import { createPinia } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import { STORE_KEY_PREFIX } from '@/lib/cache-version';

// Every persisted store writes to a `bbstat-<id>` localStorage key so the
// boot-time bust (`bustStaleCacheIfNeeded` in lib/cache-bust.ts) can find and
// wipe our state without touching anything else this origin stores. New stores
// auto-participate via the global prefix.
export function createStore() {
  const pinia = createPinia();
  pinia.use(createPersistedState({ key: (id) => `${STORE_KEY_PREFIX}${id}` }));
  return pinia;
}
