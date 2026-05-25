# Frontend cache invalidation

Reference for the `localStorage` versioning mechanism that auto-wipes
stale Pinia state on shape changes. Architectural rationale lives in
[CLAUDE.md "Changing a persisted-store shape"](../CLAUDE.md); this doc
is the operational reference — how the mechanism works, when to bump
the version, and what side effects to expect.

The matching Redis side stays manual — see "Redis is not covered" below.

## The problem

Pinia stores persist their state to `localStorage` via
`pinia-plugin-persistedstate`. Components read synchronously from the
persisted blob before the backend responds (offline-first pattern from
CLAUDE.md). A field that exists in the new TypeScript shape but not in
the persisted JSON renders `undefined` against new component code —
and `r.additions30d.toLocaleString()` blows up; `m.email` falls through
to a UUID fallback that should never trigger; etc.

Before this mechanism, the only fix was a manual
`localStorage.clear()` / `location.reload()` console command. We hit
the issue twice in one session adding `users.email` (Members page rows
showing UUID instead of email; UserSummary header doing the same). The
2026-05 `diff_stats_enabled` drop hit it earlier from the other side
(crash, not silent fallthrough).

## The mechanism

Three small files, one constant.

### `apps/frontend/src/lib/cache-version.ts`

```ts
export const CACHE_VERSION = 1;
export const VERSION_SENTINEL_KEY = 'bbstat:cache-version';
export const STORE_KEY_PREFIX = 'bbstat-';
```

`CACHE_VERSION` is a single integer. Bump it whenever a persisted-store
shape changes (see "When to bump" below).

### `apps/frontend/src/lib/cache-bust.ts`

`bustStaleCacheIfNeeded()` runs at boot, BEFORE Pinia hydrates. It:

1. Reads the sentinel value from `localStorage.getItem('bbstat:cache-version')`
2. If it matches `String(CACHE_VERSION)`, returns immediately (the
   no-op fast path — hit on every boot after the first post-bump
   reload)
3. Otherwise: walks `localStorage` backwards (`length - 1` down to 0,
   backwards because `removeItem` shifts indices) and removes every
   key starting with `bbstat-`
4. Writes the new sentinel value

Wrapped in `try/catch` to handle Safari private mode and similar
disabled-storage environments without propagating to the boot path.

### `apps/frontend/src/stores/index.ts`

Pinia is registered with `createPersistedState({ key: id =>
`bbstat-${id}` })` so every persisted store automatically writes to a
prefixed key. New stores auto-participate — no manual inventory to
keep in sync.

### `apps/frontend/src/main.ts`

```ts
bustStaleCacheIfNeeded(); // must run BEFORE the line below
app.use(createStore());
```

Ordering is load-bearing. If the bust ran after `createStore()`, the
plugin would hydrate stores from stale localStorage before we got a
chance to wipe it, and the in-memory state would be poisoned for the
session.

## When to bump `CACHE_VERSION`

Bump in the **same commit / PR** as the shape change. Triggers:

- Add, rename, or remove a field on a `defineStore(...)` body
  that is referenced inside its `persist.pick` list
- Add or remove entries from a `persist.pick` array
- Change the shape of a type that flows into a persisted store —
  `WorkspaceMember`, `UserSummary`, `TrackedRepositorySummary`,
  `ProjectStats`, `RepoActivity`, `ActivityEntry` and their nested
  types. These mostly live in `apps/frontend/src/api/client.ts`,
  mirrored from `apps/backend/src/dashboard/stats-store.ts`.
- Change the `pinia-plugin-persistedstate` config (serializer,
  key strategy, etc.)

Don't bump for:

- Adding a new persisted store (auto-participates via the prefix; no
  existing persisted state to invalidate)
- Pure backend changes that don't reach a persisted shape
- Routing / styling / non-store frontend changes

When in doubt, bump. The cost of an unnecessary bump is one refetch
wave on next page load; the cost of forgetting is a support ticket.

## Side effects

### 1. Brief loading flash on bump

Each version bump turns "page renders stale-but-readable on load" into
"page renders empty until backend responds." On a healthy network this
is < 1s. We trade availability for correctness — exactly the trade we
want, but worth flagging.

### 2. Backend-down hits harder right after a bump

Today, if the backend is unreachable, the persisted Pinia cache makes
the dashboard still readable (last-known values). Right after a bump,
that fallback is gone — first-load-after-deploy with a down backend =
error state. Recovers on next reload after backend's back up.

### 3. Multi-tab edge case

If a user has the app open in two tabs during a deploy:

- Tab A loads, sees mismatched sentinel, wipes, writes new sentinel
- Tab B was already loaded with v1 shapes in memory; its localStorage
  is now wiped under it
- Tab B mutates a store → persistedstate writes the **v1 shape back**
  under the prefixed key
- Tab B reloads later, sentinel matches → bust doesn't fire → renders
  the v1 data Tab B re-wrote

**Resolution**: reload Tab B. Happens only during the deploy window
for users who refuse to reload. If it starts biting in practice, add a
`storage`-event listener that calls `location.reload()` on sentinel
change (~10 LOC follow-up).

### 4. Storage-disabled browsers

Safari private mode + some iframe scenarios throw on
`localStorage.setItem`. The `try/catch` in `bustStaleCacheIfNeeded`
makes this a silent no-op — app still works, just without
persistence. Same UX as the user would have without the mechanism.

### 5. Forgetting to bump

Same failure mode as before the mechanism existed: manual
`localStorage.clear()` console command. No worse than today. Optional
mitigation: a CI grep that fails when `apps/frontend/src/api/client.ts`
or any `persist.pick` array changes without `CACHE_VERSION` also
changing. Not implemented; flag if forgetting becomes a pattern.

## Redis is not covered

Server-side cache (`bbstat:*` Redis keys, today only `UserSummary`
rollups via `apps/backend/src/dashboard/user-summary-cache.ts`)
survives across browser sessions AND across server restarts.
Auto-flushing on every boot would defeat the cache.

When a shape change touches a Redis-cached payload, the operator clears
that cache **by prefix** after deploy. The managed Redis is shared with
other projects, so **never `FLUSHDB`** (and don't blindly delete `bbstat:*`
either — `bbstat:bitbucket-auth-state` is meant to survive deploys). Scope
it to the affected namespace:

```bash
redis-cli -u "$REDIS_URL" --scan --pattern 'bbstat:user-summary:*' \
  | xargs -r redis-cli -u "$REDIS_URL" UNLINK
```

`--scan` is non-blocking; `xargs -r` is a no-op on zero matches. In the dev
stack (where redis runs in compose) wrap the pipeline in a shell:
`docker compose exec redis sh -c "redis-cli --scan --pattern 'bbstat:user-summary:*' | xargs -r redis-cli UNLINK"`.

Today the only Redis-cached payload is `UserSummary`. Surface this as
part of the post-deploy reminder for any change involving `UserSummary`
or future Redis-cached shapes. See the
[`feedback_pinia_persisted_cache_bust`](https://memory/internal) memory
for the split.

## Migration cost (first deploy)

When this mechanism first landed (commit `09802b8`), existing users
had localStorage entries under bare keys (`userSummary`, `members`,
etc.). The plugin now writes to `bbstat-userSummary`, `bbstat-members`,
etc. — so:

- Existing bare-keyed entries become orphans, never read by any code
  path. Harmless residue; localStorage has ~5–10MB headroom.
- On the user's first reload after deploy, the bust runs against an
  absent sentinel, finds no `bbstat-` keys to wipe (since none have
  been written yet), and writes the sentinel.
- The first time a store mutates after that reload, it writes its
  state to the new prefixed key.

End result: one transparent refetch wave on first post-deploy visit;
zero user action required. The bare-keyed orphans accumulate
indefinitely but don't break anything. A one-shot cleanup that also
removes bare keys is doable (~5 LOC) if storage hygiene matters; not
worth it today.

## Where the load-bearing files live

| Concern                   | Path                                     |
| ------------------------- | ---------------------------------------- |
| Version constant + prefix | `apps/frontend/src/lib/cache-version.ts` |
| Boot-time bust            | `apps/frontend/src/lib/cache-bust.ts`    |
| Pinia plugin config       | `apps/frontend/src/stores/index.ts`      |
| Boot wiring               | `apps/frontend/src/main.ts`              |
| Tests                     | `apps/frontend/tests/cache-bust.test.ts` |
