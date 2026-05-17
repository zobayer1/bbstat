// Bump this whenever a persisted Pinia store changes shape — field added,
// renamed, or removed; nested type altered; persisted-state plugin config
// shifted. On every app boot, `bustStaleCacheIfNeeded` (lib/cache-bust.ts)
// compares the value below against the sentinel persisted in localStorage
// and, on mismatch, wipes every `bbstat-` prefixed key so stale shapes
// can't render against new component code.
//
// Why a single global version vs per-store: shared types (`UserSummary`,
// `WorkspaceMember`, `ActivityEntry`) leak across stores, so changing one
// type often invalidates multiple stores. One bump is the simpler mental
// model — the cost of an unnecessary refetch wave is small, the cost of
// rendering stale shape is a support ticket.
//
// What does NOT live here: the server-side Redis cache. That cache is
// invalidated manually via `docker compose exec redis redis-cli FLUSHDB`
// — auto-flushing on every boot would defeat the cache. Treat that as
// a separate decision documented under "Pair every WorkspaceMember /
// UserSummary shape change with a Redis bust" in the memory.
export const CACHE_VERSION = 1;

// localStorage key holding the integer above as a string. Lives outside
// the `bbstat-` prefix so the bust function doesn't wipe its own sentinel
// on the mismatch pass.
export const VERSION_SENTINEL_KEY = 'bbstat:cache-version';

// Prefix applied to every persisted Pinia store key. Configured globally
// on the persistedstate plugin in `src/stores/index.ts` so new stores
// auto-participate — no manual inventory to keep in sync.
export const STORE_KEY_PREFIX = 'bbstat-';
