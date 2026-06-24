// Bump this whenever a persisted Pinia store changes shape — field
// added/renamed/removed, nested type altered, or persisted-state plugin config
// shifted. On boot, `bustStaleCacheIfNeeded` (lib/cache-bust.ts) compares this
// against the localStorage sentinel and, on mismatch, wipes every `bbstat-`
// prefixed key so stale shapes can't render against new component code.
//
// Single global version (not per-store) because shared types (`UserSummary`,
// `WorkspaceMember`, `ActivityEntry`) leak across stores: one bump is simpler,
// and an unnecessary refetch wave is cheaper than rendering a stale shape.
//
// The server-side Redis cache is separate and invalidated manually (scoped by
// prefix, never auto-flushed on boot — that would defeat the cache). Pair any
// WorkspaceMember / UserSummary shape change with a Redis bust.
//
// Bumped to 14 for Phase 5: WorkspaceMember switched from `userId` to
// the `entityKind` / `entityId` / `attachedUserIds` discriminated shape,
// and UserSummary.user gained the `person` field. New persisted store
// `personSummary` also participates via the global prefix.
//
// 15: the dashboard `stats` store's `topContributors` switched from the
// per-user TopContributorWithSparkline to the person-aware
// TopContributorEntity (`entityKind` / `entityId` / `attachedUserIds`).
//
// 16: WorkspaceMember gained `aliasSearch` (search-only blob of every
// linked alias's name/username/email) so a merged person is findable
// by any account, not just the primary.
//
// 17: PersonSummary.attachedUsers rows gained `lastActiveAt` (per-alias
// MAX(authored_at)) for the Person page's Attached-accounts table.
//
// 18: UserSummary gained `linkedAccounts` (sibling aliases of a merged
// person, self excluded) for the Linked-accounts table on /users/:id.
//
// 19: RepoActivity.contributors switched from the per-user RepoContributor
// to the person-aware RepoContributorEntity (`entityKind` / `entityId` /
// `attachedUserIds`) so the repo-detail list + contributor count collapse
// a person's aliases into one row.
//
// 20: ProjectStats — totals.contributorCount7d → contributorCount30d, and
// topContributors switched to the person-aware RepoContributorEntity. Repo
// table contributors30d is now an entity-distinct count (no shape change).
//
// 21: Repositories page benign-state distinctions — TrackedRepositorySummary
// gained `archived` (badged as "Archived"), and RepoSyncStatus gained
// `empty` (empty-on-bitbucket exclusions now read as benign "Empty" instead
// of a red "excluded" issue). Bust so the new syncStatus value lands
// immediately instead of stale 'excluded' rendering on empty repos.
//
// 22: RepoActivity.repository gained `archived` — the repo detail page now
// shows an "Archived" badge and neutralizes the sync icon for retired repos.
export const CACHE_VERSION = 22;

// Holds the version integer as a string. Outside the `bbstat-` prefix so the
// bust pass doesn't wipe its own sentinel.
export const VERSION_SENTINEL_KEY = 'bbstat:cache-version';

// Applied to every persisted Pinia store key (globally on the persistedstate
// plugin in `src/stores/index.ts`) so new stores auto-participate.
export const STORE_KEY_PREFIX = 'bbstat-';
