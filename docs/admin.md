# Admin endpoints

All admin endpoints live under the `/api/admin` prefix on the backend and
require no authentication (per the open-access design — see
[CLAUDE.md "Authentication"](../CLAUDE.md#authentication)). Routes are
only registered when BitBucket credentials are configured; without
`BITBUCKET_AUTH_EMAIL` / `BITBUCKET_AUTH_TOKEN` / `BITBUCKET_WORKSPACE`
they are absent entirely. All endpoints are POST; bodies are JSON where
present.

Curl examples assume local TLS (`-k` to skip cert verification against
the dev CA) and the default backend at `bbstat.localhost:8443`.

## Sync triggers

Manual analogues of the cron-driven sync jobs. Idempotent — re-running
them produces the same end state. Manual triggers **bypass the adaptive
per-repo backoff** ([docs/sync.md "Layer 5"](sync.md)) — every tracked
repo is considered regardless of how recently it was synced. The hourly
BB-call budget still applies.

| Method | Path                           | Role                                                                                                                       |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/admin/sync/discover`     | Run members + tracked-repo bootstrap sequentially. Inserts new repos from `tracked-repos.yaml`; upserts workspace members. |
| `POST` | `/api/admin/sync/commits`      | Run a full commit-sync cycle: commits tick → deepen-backfill tick → diff-stats backfill tick.                              |
| `POST` | `/api/admin/sync/pullrequests` | Run a full PR-sync cycle: iterates tracked repos, delta-pulls PRs.                                                         |

```bash
curl -k -X POST https://bbstat.localhost:8443/api/admin/sync/commits | jq
```

## Per-repository sync triggers

Single-repo equivalents of the ticks above. Useful for debugging,
backfills, and post-fix verification without waiting on the cron round-
robin. These call `syncRepositoryCommits` / `syncRepositoryPullRequests`
directly, so they also bypass the adaptive backoff layer.

| Method | Path                                                         | Role                                                                                                                      |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/admin/sync/repositories/:workspace/:slug/commits`      | Force a delta commit pull for one repo. Doesn't trigger deepen / diff-stats backfill — those run only via the full cycle. |
| `POST` | `/api/admin/sync/repositories/:workspace/:slug/pullrequests` | Force a PR delta for one repo.                                                                                            |
| `POST` | `/api/admin/sync/repositories/:workspace/:slug/deepen`       | Run one bounded page of historical deepen for one repo. Responds 503 if the BB-call budget gate is closed.                |

```bash
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/sync/repositories/tigerit/boing-server/commits | jq
```

## Curated set management

The tracked-repo set (`repositories` table) is curated. YAML seeds new
rows on first insert; per-repo flag changes happen via these endpoints.
See [`tracked-repos.yaml.example`](../tracked-repos.yaml.example) for the
seed-only semantics.

| Method   | Path                                                             | Role                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/admin/repositories`                                        | Add a new tracked repo. Body: `{ workspace: string, slug: string }`. Validates via BB `/repositories/{ws}/{slug}` before insert. Returns `201` on insert, `200` on already-tracked (idempotent), `404` if BB doesn't recognize the repo, `400` on malformed body.                                                                                                      |
| `POST`   | `/api/admin/repositories/:workspace/:slug/archive`               | Soft-retire a tracked repo (operator-initiated). Excludes it from `listTrackedRepositories()` so commit / deepen / diff-stats ticks skip it; historical data (`commits`, `sync_state`, `pull_requests`, `branches`) is preserved. Idempotent.                                                                                                                          |
| `POST`   | `/api/admin/repositories/:workspace/:slug/unarchive`             | Reverse archive. Idempotent.                                                                                                                                                                                                                                                                                                                                           |
| `POST`   | `/api/admin/repositories/:workspace/:slug/include`               | Recover from an auto-trip exclusion (`sync_excluded` set by the sync layer on 404 / empty / history-rewritten). Clears `sync_excluded` + `sync_exclude_reason` AND resets the commit-sync cursors (`last_seen_sha` → NULL, `deepen_complete` → false, `is_merge_backfill_complete` → false). Idempotent on non-excluded repos.                                         |
| `POST`   | `/api/admin/repositories/:workspace/:slug/rename`                | Operator-initiated rename. Body: `{ workspace: string, slug: string }` — the new BB identity. Verifies UUID match (the same repo, just renamed) and updates ws/slug/full_name/project. Clears any exclusion + resets cursors so the next tick re-syncs cleanly. Returns `409 uuid_mismatch` if BB resolves to a different repo.                                        |
| `DELETE` | `/api/admin/repositories/:workspace/:slug`                       | Hard delete. Cascades via FKs to commits, sync_state, branches, pull_requests. Use when archive is insufficient. Returns `200` with `{ deleted: 1 }` on success, `404` if not tracked.                                                                                                                                                                                 |
| `POST`   | `/api/admin/repositories/:workspace/:slug/backfill/is_merge`     | One-shot retroactive backfill of the `is_merge` column on already-ingested commits. Walks BB `/commits` for the repo and bulk-UPDATEs `is_merge` by sha. The cron-paced is-merge backfill tick handles steady-state coverage; this endpoint forces a full walk for one repo without waiting for the rotation. Idempotent.                                              |
| `GET`    | `/api/admin/repositories/:workspace/:slug/diff-stats/exclusions` | Read the per-repo diff-stat file-path blacklist. Returns `{ patterns: string[] }` (empty by default).                                                                                                                                                                                                                                                                  |
| `PUT`    | `/api/admin/repositories/:workspace/:slug/diff-stats/exclusions` | Replace the blacklist. Body: `{ patterns: string[] }` — picomatch globs (`*.png`, `**/pnpm-lock.yaml`, `dist/**`). Slashless patterns match at any depth (gitignore-style). Each pattern is validated; invalid ones return `400 invalid_pattern`. Cheap (DB-only). Does NOT touch commit data — pair with `POST .../reset` to apply the new filter retroactively.      |
| `POST`   | `/api/admin/repositories/:workspace/:slug/diff-stats/reset`      | Re-arm diff-stat backfill for the repo. Zeros `commits.additions/deletions/files_changed`, clears `diff_stats_synced_at`, AND zeros `commit_daily.additions/deletions` (so the dashboard shows clearly-wrong rather than subtly-wrong during the drain). The existing backfill ticks re-fetch /diffstat using the current exclusion list. Returns `{ resetCount: N }`. |

```bash
# Add a new repo to the curated set
curl -k -X POST https://bbstat.localhost:8443/api/admin/repositories \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"tigerit","slug":"some-new-repo"}'

# Archive a renamed / deprecated repo (404 noise stops, data preserved)
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/old-repo/archive

# Retroactively flag historical merge commits
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/boing-server/backfill/is_merge

# Recover a repo the sync auto-excluded (any reason)
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/some-repo/include

# Rename a repo that's been renamed on BB (UUID must match)
curl -k -X POST https://bbstat.localhost:8443/api/admin/repositories/tigerit/old-name/rename \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"tigerit","slug":"new-name"}'

# Hard-delete a tracked repo and all its history
curl -k -X DELETE \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/doomed

# Set the per-repo diff-stat blacklist, then queue a recount
curl -k -X PUT https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>/diff-stats/exclusions \
  -H 'Content-Type: application/json' \
  -d '{"patterns":["*.png","*.jpg","*.svg","**/pnpm-lock.yaml","Assets/**","dist/**"]}'
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>/diff-stats/reset
```

## Recovering auto-excluded repositories

When the sync layer detects a permanently-broken state it sets
`repositories.sync_excluded = true` and records a
`sync_exclude_reason`. The dashboard surfaces those rows with a **red
exclamation** badge ("Excluded from sync — needs attention"). The sync
ticks skip the row entirely from that point on, so the operator owns
the recovery.

Three trip causes, three playbooks. Identify the reason via the
dashboard tooltip or by querying:

```bash
psql "$DATABASE_URL" -c "SELECT full_name, sync_exclude_reason
  FROM repositories WHERE sync_excluded = true ORDER BY full_name;"
```

### Reason: `empty-on-bitbucket`

The repo exists on BB but has zero commits — cold mode succeeded with
nothing to ingest and the deepen tick confirmed BB has no history.
The exclusion stops the round-robin from cycling through the empty
row forever.

**Fix:** wait for commits to land on BB, then re-include. The cursor
reset from `/include` lets the next sync cold-walk the new history.

```bash
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>/include
```

If the repo is _expected_ to stay empty (placeholder, deprecated,
imported-but-never-used), archive it instead so it stops appearing in
the "needs attention" surface:

```bash
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>/archive
```

### Reason: `repo-404`

BB returned 404 on the commits endpoint. Either the repo was renamed
upstream (the bitbucket_uuid still exists at a different slug) or
deleted entirely. Confirm which by trying the new path in a browser
or by curling `/repositories/<ws>/<slug>` on BB.

**If renamed:** use `/rename` with the new identity. The endpoint
re-fetches BB, verifies the `bitbucket_uuid` still matches the
tracked row (`409 uuid_mismatch` if it doesn't — a safety against
pointing at a different repo by accident), updates
ws/slug/full_name/project, clears the exclusion, and resets cursors.

```bash
curl -k -X POST https://bbstat.localhost:8443/api/admin/repositories/tigerit/old-name/rename \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"tigerit","slug":"new-name"}'
```

**If deleted upstream:** either archive (preserve historical data,
stop sync work) or hard-delete (drop everything). Archive is the
right default — historical commits stay in dashboards.

```bash
# Default: keep the data, stop the sync noise
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>/archive

# Only if you want every trace of this repo gone
curl -k -X DELETE \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>
```

### Reason: `history-rewritten`

A delta sync walked BB's full main-branch history without finding our
`last_seen_sha`. The branch was force-pushed or reset; the cursor
sha is no longer reachable. The auto-trip **does not insert the new
commits** — under the same `repository_id` they would land alongside
the orphaned old shas and silently double-count in every aggregate.

**Preferred fix: wipe and re-track.** The orphan-row problem is real
and cumulative (each subsequent force-push compounds it), and there's
no honest way to reconcile two disjoint sha sets after the fact. The
DELETE + re-add gives you a clean, single-history row going forward.

```bash
# 1. Drop the tracked row and all its history (cascades to commits,
#    sync_state, branches, pull_requests).
curl -k -X DELETE \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>

# 2. Re-add it. POST /repositories does a BB metadata fetch and
#    inserts a fresh row + sync_state. Returns 201 on success.
curl -k -X POST https://bbstat.localhost:8443/api/admin/repositories \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"tigerit","slug":"<slug>"}'
```

The next commit-sync tick cold-walks recent history; deepen +
is-merge backfill catch up the rest over subsequent ticks. Dashboards
will show a drop in this repo's historical contribution counts until
the deepen tick has filled coverage — that's the cost of the clean
slate.

**Alternative (faster but dirty): `/include` and accept the orphans.**
Only choose this when the force-push touched a small recent slice
(e.g., a squash-merge or signed-commit rewrite of the last few
commits), so the resulting orphan rows are a minor fraction of total
history.

```bash
curl -k -X POST \
  https://bbstat.localhost:8443/api/admin/repositories/tigerit/<slug>/include
```

`/include` clears `sync_excluded` and resets cursors (`last_seen_sha
= NULL`, `deepen_complete = false`, `is_merge_backfill_complete =
false`); cold-mode then inserts the new shas alongside the old ones.
The old rows remain in the DB indefinitely — they don't collide on
`(repository_id, sha)`, so insertion just adds the new history beside
them. Dashboard aggregates over `commits` / `commit_daily` will
include both sets.

## Error shapes

All endpoints return JSON for both success and error responses. Errors
follow:

- `400` — `{ error: "invalid_body", issues: [...] }` — Zod parse failure on the request body. `/diff-stats/exclusions` PUT also returns `{ error: "invalid_pattern", pattern: "…", message: "…" }` if a glob fails to parse.
- `404` — `{ error: "not_tracked", fullName: "ws/slug" }` — Repo not in the curated set (for per-repo endpoints), or `{ status: "not-found" }` on the add endpoint when BB rejects the lookup. `/rename` also returns `{ error: "bitbucket_not_found" }` when BB itself 404s the new ws/slug.
- `409` — `{ error: "uuid_mismatch", stored: {...}, target: {...} }` — `/rename` only. The target ws/slug resolves to a different BB repo than the tracked row. Merging would silently corrupt the history; use `POST /repositories` to track the target separately instead.
- `503` — `{ error: "budget_below_threshold", ... }` — Used only by `/deepen` when the BB call budget is too low to start.
- `500` — unhandled exception. Check the backend logs.

Successful responses carry endpoint-specific shapes (typically the sync
result body for trigger endpoints, or `{ fullName, ...flags }` for
curated-set endpoints).
