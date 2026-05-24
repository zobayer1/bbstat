# Person layer — alias merge (Phase 5)

One human, many BitBucket accounts. A contributor who pushes from a corp
account and a personal account — typically with a different git email
from each — lands as two `users` rows with disjoint commit histories.
Their scores split, the leaderboard under-counts them, and the
concentration charts under-represent them. The **person layer** lets an
operator declare "these N `users` rows are the same human" so every
leaderboard-style read collapses them into one canonical identity.

Discovery is the operator's job — there is **no auto-detection**. The
Members page's existing fuzzy search (name / username / email) is how you
find duplicate identities; these endpoints are the actuators that wire
the merge into the database. Per [`CLAUDE.md`](../CLAUDE.md), the per-user
detail page at `/users/:id` still exists for each underlying account; the
person layer is an aggregate _above_ users, not a replacement.

## Model

```
people                         users
------                         -----
id            ◄───────────┐    id
display_name              └──  person_id        (NULL = unattached)
created_at                     is_primary_for_person
updated_at                     …

person_score   (PK person_id → people, ON DELETE CASCADE)
  — mirror of user_score, recomputed across the alias union
```

- **`users.person_id`** — NULL means the user is its own person
  (unattached). Non-NULL attaches the user as one alias of `people.id`.
  Many users can share one `person_id`.
- **`users.is_primary_for_person`** — flags the alias that supplies the
  person's UI defaults (display-name fallback, BB avatar, email-mailto).
  A partial unique index enforces **≤1 primary per person**; a CHECK
  (`NOT is_primary_for_person OR person_id IS NOT NULL`) keeps the flag
  pinned to attached aliases.
- **`people.display_name`** — operator-canonical name. NULL means "use
  the primary alias's display_name." The read paths COALESCE through the
  primary alias.
- **No `people.primary_user_id` column.** An earlier draft put the
  primary pointer on `people`, which created a circular FK with
  `users.person_id` that broke `pg_dump --data-only` restores once
  merges existed. The boolean-on-`users` design keeps the schema a DAG.
  See migration `apps/backend/schema/V1_4__people_layer.sql`.

### The `leaderboard_entries` view

A `UNION ALL` over two branches that the read paths select from instead
of `user_score` directly:

- **person branch** — one row per `person_score`, joined to `people`
  with `display_name` COALESCE'd through the primary alias and
  `is_workspace_member` OR'd across attached aliases.
- **user branch** — one row per `user_score` whose user is unattached
  (`users.person_id IS NULL`).

`entity_kind` (`'person'` / `'user'`) discriminates the two; `entity_id`
is a `people.id` or `users.id` accordingly. Drizzle-kit does **not**
track views — the DDL lives only in the SQL migration files, so a change
to any underlying column shape needs an explicit `DROP VIEW` +
`CREATE VIEW` in a new migration (see the header comment in
`V1_4__people_layer.sql`).

## Person-aware scoring rollup

`person_score` is the alias-union sibling of `user_score`, recomputed by
the same `recomputeAllScores()` orchestrator that runs at the tail of
every commit-sync tick (and via `make recompute-user-scores` /
`POST /api/admin/scores/recompute`). The person pass reuses the pure
`aggregateUserScores()` math by relabeling each commit's key from
`author_user_id` to `users.person_id`, then runs the same formulas over
the unioned commit set. Composition:

- `score_trending`, `volume_*` — sum across aliases (linear in commits).
- `consistency_90d`, `p95_churn_cap`, `median_churn_90d`, `p95_churn_90d`
  — recomputed against the unioned commit set (distributional, not
  additive).
- `active_days_90d` — distinct active-day count across aliases.
- `is_dormant` — true iff every alias is dormant (union is empty in the
  window).
- `days_since_first_commit` — oldest commit across aliases.
- `badge` / `badge_tier` — recomputed against the unioned inputs.

The recompute also **prunes** `person_score` rows whose person no longer
has any attached aliases (e.g. after a detach that empties the person),
so the rollup state always matches the current `users.person_id` graph.
See [`docs/scoring.md`](scoring.md) "Person-aware rollup" for the math.

## Admin endpoints

All under `/api/admin/people` (open by design today — see
[`docs/admin.md`](admin.md) for the auth-gating seam). Every mutation
that changes commit attribution runs a `recomputeAllScores()` pass +
DELs the affected aliases' `bbstat:user-summary:*` Redis keys, then emits
an SSE event the frontend uses to re-fetch. `setPrimary` is a UI-only
flag swap and skips the recompute / cache bust.

| Verb + path                | Body                               | Effect                                                                                                     |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST /people`             | `{ displayName?, primaryUserId? }` | Create a person; optionally first-attach `primaryUserId` as primary in the same txn. → `201 { id, … }`     |
| `GET /people`              | —                                  | List every person with its attached-alias roster.                                                          |
| `GET /people/:id`          | —                                  | One person + roster. `404` if absent.                                                                      |
| `PATCH /people/:id`        | `{ displayName }`                  | Edit the canonical name.                                                                                   |
| `POST /people/:id/attach`  | `{ userId, makePrimary? }`         | Attach a user. Auto-elects primary if the person has none. `409` if the user is already attached anywhere. |
| `POST /people/:id/detach`  | `{ userId }`                       | Detach one alias. `400` if not attached to this person.                                                    |
| `POST /people/:id/primary` | `{ userId }`                       | Atomic primary swap (no recompute).                                                                        |
| `DELETE /people/:id`       | —                                  | Dissolve: clear `person_id` on all aliases, cascade-delete `person_score`.                                 |

### First-merge recipe

```bash
BASE=https://bbstat.localhost:8443/api/admin/people

# 1. Find the duplicate identities via the /members name/email search.
#    Note the two users.id values (say 4 = corp, 5 = personal).

# 2. Create the person, attaching the corp account as primary.
PID=$(curl -ks -X POST "$BASE" -H 'content-type: application/json' \
  -d '{"displayName":"Jane Doe","primaryUserId":4}' | jq -r .id)

# 3. Attach the second account.
curl -ks -X POST "$BASE/$PID/attach" -H 'content-type: application/json' \
  -d '{"userId":5}'

# 4. (optional) move primary to the personal account.
curl -ks -X POST "$BASE/$PID/primary" -H 'content-type: application/json' \
  -d '{"userId":5}'

# Undo entirely:
curl -ks -X DELETE "$BASE/$PID"
```

In the containerized prod stack these are reached through the deployer's
reverse proxy at the same `/api/admin/people` paths; there's no
script-only variant (unlike the rollup / sweep one-shots).

## Frontend surface

- **`/members`** — person rows carry a violet `merged ×N` pill and link
  to `/people/:id`; unattached users link to `/users/:id`. The
  Lorenz/Gini + activity-status charts derive from the unified entity
  list, so concentration reflects the merged reality.
- **`/people/:id`** (`apps/frontend/src/views/Person.vue`) — aggregated
  detail: stat cards, 365-day commit heatmap, top-repos table, and an
  "Attached accounts" panel listing each alias (with primary badge) that
  links through to its `/users/:id` page.
- **`/users/:id`** — gains a "Part of: <person>" banner when the account
  is attached.
- **Live updates** — the six `person.*` SSE events
  (`created` / `updated` / `attached` / `detached` / `primary-changed` /
  `dissolved`) re-fetch the Members store and the keyed person-summary
  store, so an operator's merge shows up in open tabs without a reload.

## When you change a person-facing shape

`WorkspaceMember`, `UserSummary.user.person`, and `PersonSummary` are
mirrored between `apps/backend/src/dashboard/stats-store.ts` and
`apps/frontend/src/api/client.ts`. On any shape change:

1. Update both mirrors in lockstep.
2. Bump `CACHE_VERSION` in `apps/frontend/src/lib/cache-version.ts` (the
   Pinia persisted stores `members` + `personSummary` cache these
   payloads — a stale shape renders `undefined`).
3. `docker compose exec redis redis-cli FLUSHDB` after deploy if the
   change touches a `bbstat:*` Redis-cached payload (today: `UserSummary`
   via the user-summary cache; `PersonSummary` is uncached for now).

See [`docs/frontend-cache.md`](frontend-cache.md) for the `CACHE_VERSION`
mechanism.

## Deferred (out of Phase 5 scope)

- **Per-person activity feed** — `/api/activity` filters by a single
  `actor` (user_id). A person feed needs multi-actor support; the Person
  page ships without the unified commit+PR stream for now.
- **Top Contributors person-awareness** — the dashboard panel
  (`getTopContributors`) still groups per user, so a merged person's
  aliases appear as separate rows there. Only the `/members` leaderboard
  is person-aware.
- **`bbstat:person-summary:*` Redis cache** — `/api/stats/people/:id/summary`
  reads through to Postgres on every request. Cheap at current scale;
  mirror the user-summary cache pattern (and DEL from
  `refreshAfterPersonMutation` in `routes/admin.ts`) if person pages get
  hot.
- **Admin UI for merging** — operator-via-curl only; the dashboard merge
  surface is Phase 8.

## Where the load-bearing files live

| Concern                   | File                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Schema (table + view)     | `apps/backend/src/db/schema.ts`, `apps/backend/schema/V1_4__people_layer.sql`            |
| Store (CRUD + invariants) | `apps/backend/src/people/store.ts`, `errors.ts`                                          |
| Admin routes              | `apps/backend/src/routes/admin.ts`                                                       |
| Scoring rollup            | `apps/backend/src/scoring/rollup.ts` (`recomputePersonScores`, `recomputeAllScores`)     |
| Read shapes               | `apps/backend/src/dashboard/stats-store.ts` (`listWorkspaceMembers`, `getPersonSummary`) |
| SSE events                | `apps/backend/src/events/bus.ts` (`person.*` variants)                                   |
| Frontend                  | `apps/frontend/src/views/Person.vue`, `Members.vue`, `stores/personSummary.ts`           |
