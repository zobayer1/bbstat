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
them produces the same end state.

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
robin.

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

| Method | Path                                                         | Role                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/admin/repositories`                                    | Add a new tracked repo. Body: `{ workspace: string, slug: string }`. Validates via BB `/repositories/{ws}/{slug}` before insert. Returns `201` on insert, `200` on already-tracked (idempotent), `404` if BB doesn't recognize the repo, `400` on malformed body.                                                    |
| `POST` | `/api/admin/repositories/:workspace/:slug/archive`           | Soft-retire a tracked repo. Excludes it from `listTrackedRepositories()` so commit / deepen / diff-stats ticks skip it; historical data (`commits`, `sync_state`, `pull_requests`, `branches`) is preserved. Idempotent.                                                                                             |
| `POST` | `/api/admin/repositories/:workspace/:slug/unarchive`         | Reverse archive. Idempotent.                                                                                                                                                                                                                                                                                         |
| `POST` | `/api/admin/repositories/:workspace/:slug/backfill/is_merge` | One-shot retroactive backfill of the `is_merge` column on already-ingested commits. Walks BB `/commits` for the repo and bulk-UPDATEs `is_merge` by sha. Use after the column was introduced (migration 0006) on repos whose history pre-dates it; new commits going forward are flagged at insert time. Idempotent. |

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
```

## Error shapes

All endpoints return JSON for both success and error responses. Errors
follow:

- `400` — `{ error: "invalid_body", issues: [...] }` — Zod parse failure on the request body.
- `404` — `{ error: "not_tracked", fullName: "ws/slug" }` — Repo not in the curated set (for per-repo endpoints), or `{ status: "not-found" }` on the add endpoint when BB rejects the lookup.
- `503` — `{ error: "budget_below_threshold", ... }` — Used only by `/deepen` when the BB call budget is too low to start.
- `500` — unhandled exception. Check the backend logs.

Successful responses carry endpoint-specific shapes (typically the sync
result body for trigger endpoints, or `{ fullName, ...flags }` for
curated-set endpoints).
