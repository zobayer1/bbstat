# Workspace Members page

Operator + reader notes for the `/members` page and everything that feeds
it. Background and design rationale lives in the commit messages
(`297548d` through `7308cf0`); this doc is the durable reference — what
the page renders, where each piece of data comes from, and how to extend
or troubleshoot it.

The page surfaces every contributor we've ingested at least one commit
for, with org-wide aggregates at the top and a searchable / sortable
table below. Reachable from the dashboard's "Workspace Members" stat
card (the third card on the top row) — `apps/frontend/src/views/Dashboard.vue:163`.

The page also doubles as the **ShipShow Score leaderboard** — the default
sort is `scoreTrending` (Momentum), with per-window volume columns and
the persona-badge column to its right. The ranking algorithm, badge
cascade, and persona / dormant / ex-member categorization rules all live
in [`docs/scoring.md`](scoring.md); this doc focuses on the page surface
and how the underlying data is fetched.

## Data flow

```
GET /api/stats/members?window=7d|30d
        └──► StatsStore.listWorkspaceMembers(windowDays)        # apps/backend/src/dashboard/stats-store.ts
                  └──► single Postgres query, 4 CTEs
                          ├── base        (per-user aggregates from commit_daily, HAVING sum > 0)
                          ├── last_active (MAX(authored_at) per user from commits)
                          ├── daily       (last-30-day per-(user,day) commit_count)
                          └── spark       (array_agg into 30-element series, oldest-first)
                  └──► returns WorkspaceMember[]
                  ▼
useMembersStore.fetch()                                          # apps/frontend/src/stores/members.ts
        ├── persisted via pinia-plugin-persistedstate
        └── subscribes to liveBus events for refetch
                  ▼
Members.vue                                                      # apps/frontend/src/views/Members.vue
        ├── activity buckets       → ActivityStatusDonut.vue
        ├── lorenzValues           → LorenzCurve.vue
        ├── fuzzy search (Fuse.js) over displayName/username/email
        └── sortable table with per-row Sparkline.vue
```

The backend ships the full eligible roster in one round-trip — fuzzy
search, sort, and pagination all run on the frontend over the cached
`members.value`. This is fine at org scale (hundreds of members at most;
the 100-per-page client-side pagination handles UI weight). It also
keeps the SSE refresh story simple — one refetch, the entire derived
view recomputes.

## Eligibility filter

The backend query filters out users who have NEVER landed a commit
(`HAVING sum(commit_count) > 0` in the `base` CTE — see
`stats-store.ts:953`). Users who exist in the `users` table from a
workspace-members sync but who've never authored anything are absent
from the page. The dashboard's "Workspace Members" stat card counts
**all** users including those — so the on-page total can be slightly
smaller than the card. That's intentional: lurkers add noise to the
roster; the page is "people who ship code."

A user who DID commit historically but has been quiet recently still
shows up — with `0` in the windowed columns and a real
`commitsAllTime` / `lastActiveAt`. A quiet 7d window doesn't empty the
table.

## Aggregate charts (top of page)

Two SVG charts, both pure components with no external charting
dependency. Captions sit at the card level (not inside the chart
components) so they align across cards via the grid's `items-stretch`
default.

### Activity-status donut

`apps/frontend/src/components/ActivityStatusDonut.vue`

Buckets every member by how recently they last committed, relative to
now. Window-independent — the donut is always answering "is the team
alive _right now_?" — so the 7d/30d toggle doesn't change it.

| Bucket       | Boundary       | Color (Tailwind)        |
| ------------ | -------------- | ----------------------- |
| Active · 7d  | < 7 days ago   | emerald-500 (`#10b981`) |
| Active · 30d | 7–30 days ago  | blue-500 (`#3b82f6`)    |
| Active · 90d | 30–90 days ago | amber-500 (`#f59e0b`)   |
| Dormant      | > 90 days ago  | slate-400 (`#94a3b8`)   |

Buckets are mutually exclusive — "Active · 30d" means active within
30 days but **not** within 7. Slices therefore sum to total members
and the donut reads as a partition, not nested rings.

Type scales with `outerRadius` (~10% for the overline label, ~28% for
the centered total) so caller can resize the donut and the type
stays legible. Default in Members.vue: `outerRadius=120, innerRadius=76`.

### Lorenz concentration curve

`apps/frontend/src/components/LorenzCurve.vue`

Cumulative share of commits (y) vs cumulative share of members (x),
sorted ascending by commits. A curve hugging the diagonal means flat
distribution; a curve bowed deeply toward the bottom-right means a
small minority does most of the work. Gini coefficient (trapezoid-
integrated as `1 - 2*area_under_curve`) renders in the top-left of
the plot as the canonical inequality summary stat.

**Window-scoped** — driven by `commitsWindow`, so toggling 7d ↔ 30d
recomputes the curve. The component filters zero-commit-in-window
members internally; including them would flatten the left tail and
understate the inequality.

Both axes show `0%` / `100%` corner ticks plus axis titles
("Members (cumulative)" / "Commits (cumulative)"). Empty-state copy
when there are no positive values ("No commits in window").

## Search, sort, pagination

| Surface              | Field(s)                                                                        | Notes                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Fuse.js fuzzy search | `displayName`, `username`, `email`                                              | `threshold: 0.4`, `ignoreLocation: true` (matches a substring anywhere). Index rebuilds on every store refresh.             |
| Sortable columns     | `displayName`, `commitsWindow`, `commitsAllTime`, `reposWindow`, `lastActiveAt` | Sparkline column intentionally not sortable — sort over a shape has no useful meaning.                                      |
| Pagination           | 100 rows / page                                                                 | Client-side only, applied AFTER search + sort. First/Prev/Next/Last buttons; page resets to 1 on every search-input change. |

The window-toggle (`7d` / `30d`) sits next to the search input as a
segmented control. Columns split visually into two groups at a 2px
vertical border: **window-scoped** on the left (Commits, +/−, Repos)
and **window-independent** on the right (Trend 30d, Last active,
All-time). The Trend column carries the separator border on its left
edge so the rule stays anchored to the toggle/no-toggle boundary
regardless of which columns get added.

## Live updates (SSE)

`useMembersStore` subscribes to the in-app `liveBus` (the SSE consumer
at `apps/frontend/src/lib/live.ts`):

| Event                   | Action                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `tick.commits.complete` | `applyTickComplete()` → refetch if `lastFetchedAt !== null` |
| `repository.deleted`    | same                                                        |
| `liveBus.onFallback`    | same                                                        |

Skipped intentionally:

- `tick.prs.complete` — no field in `WorkspaceMember` is sourced from
  `pull_requests`, so a PR tick can't move anything we render.
- `repository.sync-excluded` / `repository.included` — excluded repos'
  commit data is already in the DB; toggling exclusion only changes
  future sync behavior, not aggregates.

`applyTickComplete` short-circuits when `lastFetchedAt === null`
(i.e. the page has never been visited this session) so a sleeping tab
doesn't wake into network work.

## Per-row sparkline

`apps/frontend/src/components/Sparkline.vue` (reused from the dashboard
Top Contributors panel).

The backend SQL already produces a 30-element `last30Days` series per
member (the `spark` CTE — `array_agg` over a generated date range
left-joined to per-(user,day) counts so missing days become zero,
oldest-first). The component renders it as an inline SVG polyline.

The sparkline is fixed at **30 days regardless of the toggle** —
that's why its column lives on the right-hand side of the vertical
separator with the other window-independent fields, and why the
header reads "Trend (30d)" with the parenthesized window callout.

## Stat-card entry surface

The Dashboard's "Workspace Members" stat card
(`apps/frontend/src/views/Dashboard.vue:163`) is wrapped in a
`RouterLink` with two visual affordances:

- **3D hover tilt** via `[perspective:1200px]` on the section + a
  composite transform on the link (`translateY(-4px) scale(1.02)
rotateX(6deg) rotateY(-4deg)` + `hover:shadow-xl`). Snappy
  `transition-all duration-200 ease-out`.
- **Animated icon** — a Heroicons-style three-person "users" glyph
  anchored to the card's right edge (`absolute right-4 size-14`),
  resting in `text-slate-300` and flipping to `text-blue-500` on the
  parent's `group-hover` / `group-focus-visible`.

The glyph is `pointer-events-none` so clicks always go to the link,
not the icon.

## Git-author email capture

The email shown under each row's display name is extracted from the
git-style `author.raw` field on commits (e.g.
`"Alice Example <alice@example.com>"`). It is **NOT** a verified
workspace email — BB's `/workspaces/{ws}/members` endpoint never
exposed email, so this is whatever each contributor had configured
locally when they pushed. Caveats:

- One person can produce multiple emails across machines (corp /
  personal mix). Write-once means whatever landed **first** sticks.
- BB synthesizes `*@users.noreply.bitbucket.org` for web-merge
  commits; mirror flows produce `*@users.noreply.github.com` etc.
  These are filtered at parse time so they never reach the column.
- A fresh laptop can produce a one-off bogus address. That sticks
  too. Acceptable for a transparency dashboard; if it becomes a
  problem, see "Resetting an individual user's email" below.

### Parser

`apps/backend/src/sync/author-email.ts` — pure function, no I/O.

1. Extract the `<...>` segment with a regex
2. Lowercase
3. Shape-check: requires `@`, at least one `.` in the domain, non-
   empty local part and domain
4. Filter `noreply` synthetics — local part starts with `noreply`,
   domain contains `noreply.`, or `+noreply@` pattern

Returns `null` on any failed check. 14 unit tests in
`author-email.test.ts` cover standard parsing, casing, whitespace,
noreply variants, subdomains, `+` aliases (kept), and null/undefined
inputs.

### Ingest hooks

| Path                 | File                                       | Trigger                                                                                                                                |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Forward commit sync  | `apps/backend/src/sync/commits.ts`         | After `resolveUserIdsByUuid` resolves user IDs; builds email entries from commits whose UUID matched the local user set                |
| Deepen-backfill walk | `apps/backend/src/sync/deepen-backfill.ts` | `buildInsertInput` parses `author.raw` once, the call to `setUserEmailsIfMissing` happens alongside the existing UUID resolution batch |

Both hooks call `CommitStore.setUserEmailsIfMissing(entries)` — a
single `UPDATE users SET email = data.email FROM (VALUES ...) WHERE
bitbucket_uuid = data.uuid AND users.email IS NULL`. The `IS NULL`
predicate is what enforces write-once.

### Retroactive admin backfill

For users whose only commits predate the column, run:

```bash
curl -k -X POST https://bbstat.localhost:8443/api/admin/users/backfill-emails
```

The endpoint (`apps/backend/src/routes/admin.ts`):

1. Calls `CommitStore.listUsersMissingEmailWithLastCommit(limit)` —
   `DISTINCT ON (author_user_id)` over `commits ORDER BY authored_at
DESC`, joined to `users WHERE email IS NULL` and filtered to
   `archived = false AND sync_excluded = false`. Uses the existing
   `commits_author_authored_idx` index; fast even at hundreds of
   thousands of commits.
2. For each row: `paginateCommits(ws, slug, { include: sha })` and
   read the first yielded item (BB returns the requested sha first
   in include-mode). Parses `<email>` from its `author.raw`.
3. Batches everything into one `setUserEmailsIfMissing` call.

Response shape:

```json
{
  "attempted": 35,
  "fetched": 35,
  "written": 35,
  "skippedNoParseableEmail": 0,
  "fetchFailed": 0
}
```

Per-user fetch failures are isolated (`try/catch` around each user);
one BB hiccup doesn't poison the rest. Default cap is 500; hard cap
is 2000 — well above any realistic "few users" steady state but
prevents a misconfigured workspace from burning the BB-call budget
in one shot. Override via `?limit=N`.

**Idempotent** — re-running after a successful pass finds nothing
(rows with email no longer match the seed query).

### Resetting an individual user's email

Not implemented as an admin endpoint today. If a contributor's
captured email goes wrong (typo on first commit, deliberately changed
later, etc.), the manual path is:

```sql
UPDATE users SET email = NULL WHERE bitbucket_uuid = '{the-uuid}';
```

Then either wait for their next commit to repopulate via the live
ingest path, or run the backfill endpoint to capture it from their
most recent commit. If this becomes common enough to need a button,
`POST /api/admin/users/:userId/email/clear` is ~10 lines.

### Surfacing in the UI

- **Members row** — rendered muted under `displayName`/`@username`
  (`text-xs text-slate-400 truncate`, with `title="..."` so the full
  address shows on hover). Null hides the entire div.
- **User detail page header** (`UserSummary.vue:29-30`) — email
  replaces the BitBucket UUID under the name when available; UUID
  remains as the `font-mono` fallback when email is null. The email
  reads in the regular font; the UUID stays monospaced since it's an
  opaque identifier.
- **Fuzzy search** — emails are a Fuse search key alongside display
  name and username, so an operator can find a contributor by
  partial email.

## When you change a member-facing shape

Anything that touches `WorkspaceMember` or `UserSummary.user` (or the
SQL that produces them):

1. Update both type mirrors in lockstep — backend in
   `apps/backend/src/dashboard/stats-store.ts`, frontend in
   `apps/frontend/src/api/client.ts`. ESLint won't catch a drift
   between them; review carefully.
2. Update the SQL `SELECT` clause and the row mapper in the Drizzle
   `StatsStore` impl.
3. **Bump `CACHE_VERSION`** in `apps/frontend/src/lib/cache-version.ts`
   — see [docs/frontend-cache.md](frontend-cache.md) for the
   mechanism.
4. **Bust Redis** if the field flows through the `UserSummary` Redis
   cache — **by prefix, never `FLUSHDB`** (the managed Redis is shared):
   `redis-cli -u "$REDIS_URL" --scan --pattern 'bbstat:user-summary:*' | xargs -r redis-cli -u "$REDIS_URL" UNLINK` after deploy.
   (Today the only Redis-cached payload is `UserSummary`; there's no
   automatic version-bumping equivalent server-side.)
5. Update test fixtures — `apps/backend/tests/stats.test.ts`
   `sampleMembers` / `sampleUserSummary` and
   `apps/frontend/tests/userSummary.store.test.ts`.

## Where the load-bearing files live

| Concern                   | Path                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Schema                    | `apps/backend/src/db/schema.ts` (`users.email` column)                                                                   |
| Drizzle migration         | `apps/backend/drizzle/0012_cold_champions.sql`                                                                           |
| Flyway mirror             | `apps/backend/schema/V1_13__add_users_email.sql`                                                                         |
| Backend type + SQL        | `apps/backend/src/dashboard/stats-store.ts` (`WorkspaceMember`, `UserSummary`, `listWorkspaceMembers`, `getUserSummary`) |
| Frontend type             | `apps/frontend/src/api/client.ts` (`WorkspaceMember`, `UserSummary`)                                                     |
| Members store             | `apps/frontend/src/stores/members.ts`                                                                                    |
| Members page              | `apps/frontend/src/views/Members.vue`                                                                                    |
| Activity donut            | `apps/frontend/src/components/ActivityStatusDonut.vue`                                                                   |
| Lorenz curve              | `apps/frontend/src/components/LorenzCurve.vue`                                                                           |
| Email parser              | `apps/backend/src/sync/author-email.ts` (+ `.test.ts`)                                                                   |
| Ingest hooks              | `apps/backend/src/sync/commits.ts`, `apps/backend/src/sync/deepen-backfill.ts`                                           |
| Bulk write SQL            | `apps/backend/src/sync/commit-store.ts` (`setUserEmailsIfMissing`)                                                       |
| Admin backfill            | `apps/backend/src/routes/admin.ts` (`POST /api/admin/users/backfill-emails`)                                             |
| Stat-card entry           | `apps/frontend/src/views/Dashboard.vue:163`                                                                              |
| User-detail email surface | `apps/frontend/src/views/UserSummary.vue:24-31`                                                                          |
