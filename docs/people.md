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

### Merge recipe (curl)

Set `BASE` once. In dev it's the host backend; in containerized prod it's
the same path behind the deployer's reverse proxy (there's no script-only
variant, unlike the rollup / sweep one-shots).

```bash
BASE=https://bbstat.localhost:8443/api/admin/people   # dev
# BASE=https://bbstat.onudaan.com/api/admin/people    # prod

# 0. Find the duplicate identities via the /members name/email search.
#    Note the users.id values — say 4 = corp account, 5 = personal account.
#    (You can also list every user the API knows via the members endpoint:)
#    curl -ks https://bbstat.localhost:8443/api/stats/members | jq '.[] | {entityId, displayName, email}'
```

**Create the person with a canonical name + designate the primary in one
call.** `primaryUserId` first-attaches that alias _and_ flags it primary,
so the person's display name, avatar, and mailto default to it:

```bash
PID=$(curl -ks -X POST "$BASE" -H 'content-type: application/json' \
  -d '{"displayName":"Jane Doe","primaryUserId":4}' | jq -r .id)
echo "created person $PID"
```

**Attach the other alias.** Default keeps the existing primary (alias 4):

```bash
curl -ks -X POST "$BASE/$PID/attach" -H 'content-type: application/json' \
  -d '{"userId":5}' | jq
```

Attach **and** make this one primary in a single call (use when the alias
you're adding should be the canonical face):

```bash
curl -ks -X POST "$BASE/$PID/attach" -H 'content-type: application/json' \
  -d '{"userId":5,"makePrimary":true}' | jq
```

**Naming variants:**

```bash
# Rename later (operator-canonical name beats the primary alias's name):
curl -ks -X PATCH "$BASE/$PID" -H 'content-type: application/json' \
  -d '{"displayName":"Jane Q. Doe"}' | jq

# Clear the override so the UI falls back to the primary alias's name:
curl -ks -X PATCH "$BASE/$PID" -H 'content-type: application/json' \
  -d '{"displayName":null}' | jq

# Create without a name (display falls back to primary alias) but still set primary:
curl -ks -X POST "$BASE" -H 'content-type: application/json' \
  -d '{"primaryUserId":4}' | jq
```

**Swap the primary** without changing attribution (UI-only flag, no
recompute):

```bash
curl -ks -X POST "$BASE/$PID/primary" -H 'content-type: application/json' \
  -d '{"userId":5}' | jq
```

**Inspect / undo:**

```bash
curl -ks "$BASE/$PID" | jq               # one person + full alias roster
curl -ks "$BASE" | jq                    # every person
curl -ks -X POST "$BASE/$PID/detach" -H 'content-type: application/json' \
  -d '{"userId":5}' | jq                 # detach one alias (person survives)
curl -ks -X DELETE "$BASE/$PID" | jq     # dissolve entirely → {detachedUserIds:[…]}
```

**Errors worth knowing:** attaching a user already on another person →
`409 user_already_attached` (one user maps to ≤1 person); detaching a user
not on this person → `400 user_not_attached_to_person`; a bad person id →
`404 person_not_found`.

## Frontend surface

Person-awareness reaches **every** contributor surface (1.2.0) — a merged
person collapses its aliases everywhere it's counted, never just on one
page. The shared `×N` violet pill + `/people/:id` link pattern is reused
on every list.

- **`/members`** — person rows carry a violet `merged ×N` pill and link
  to `/people/:id`; unattached users link to `/users/:id`. The
  Lorenz/Gini + activity-status charts derive from the unified entity
  list, so concentration reflects the merged reality. `aliasSearch` makes
  a merged person findable by **any** linked account's name / username /
  email, not just the primary. The page also carries an activity feed.
- **Dashboard Top Contributors** — keys on the merged entity
  (`TopContributorEntity`), so a person appears once with the `×N` pill.
- **`/repositories/:ws/:slug`** — the "Contributors — last 30 days" list
  and the contributor stat card are entity-keyed
  (`RepoContributorEntity`); aliases that both touched the repo collapse.
- **`/projects/:key`** — the "Contributors — last 30 days" table, the
  "Active contributors — 30d" stat card, and the repositories table's
  per-repo "Contributors — 30d" column are all entity-distinct.
- **Activity (`/activity` + every embedded feed)** — the `ActorPicker`
  filter and `/api/activity*` accept a person _or_ user actor; a person
  expands server-side across all aliases. The page title chip resolves
  either entity kind identically.
- **`/people/:id`** (`apps/frontend/src/views/Person.vue`) — aggregated
  detail: stat cards, 365-day commit heatmap, top-repos table, the
  unified commit+PR activity feed (expanded across aliases), and an
  "Attached accounts" panel listing each alias (primary badge + per-alias
  **Last active**) linking through to its `/users/:id` page.
- **`/users/:id`** — gains a "Part of: <person>" link by the name when
  attached, plus a "Linked accounts" table of the sibling aliases with
  the canonical-person link in its footer.
- **Live updates** — the six `person.*` SSE events
  (`created` / `updated` / `attached` / `detached` / `primary-changed` /
  `dissolved`) re-fetch the Members store and the keyed person-summary
  store, so an operator's merge shows up in open tabs without a reload.

## When you change a person-facing shape

`WorkspaceMember`, `UserSummary` (incl. `user.person` + `linkedAccounts`),
`PersonSummary`, `TopContributorEntity`, and `RepoContributorEntity` (used
by both `RepoActivity.contributors` and `ProjectStats.topContributors`)
are mirrored between `apps/backend/src/dashboard/stats-store.ts` and
`apps/frontend/src/api/client.ts`. On any shape change:

1. Update both mirrors in lockstep.
2. Bump `CACHE_VERSION` in `apps/frontend/src/lib/cache-version.ts` (the
   Pinia persisted stores `members` + `personSummary` cache these
   payloads — a stale shape renders `undefined`).
3. Clear the affected Redis cache **by prefix** after deploy if the change
   touches a `bbstat:*` Redis-cached payload (today: `UserSummary` via the
   user-summary cache; `PersonSummary` is uncached for now). The managed
   Redis is shared, so **never `FLUSHDB`** — scope it:
   `redis-cli -u "$REDIS_URL" --scan --pattern 'bbstat:user-summary:*' | xargs -r redis-cli -u "$REDIS_URL" UNLINK`
   (this also preserves `bbstat:bitbucket-auth-state`, which survives deploys).

See [`docs/frontend-cache.md`](frontend-cache.md) for the `CACHE_VERSION`
mechanism.

## Deferred (still out of scope)

The two read-path deferrals from the original Phase 5 commits — per-person
activity feed and Top Contributors person-awareness — **landed in 1.2.0**
(see Frontend surface above). What's left:

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
