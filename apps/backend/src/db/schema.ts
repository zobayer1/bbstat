import { sql } from 'drizzle-orm';
import {
  pgSchema,
  serial,
  text,
  timestamp,
  date,
  integer,
  boolean,
  doublePrecision,
  index,
  unique,
  uniqueIndex,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// All tables / enums / sequences live under the `bbstat` schema, NOT
// `public`: production runs a restricted role with no CREATE on `public`.
//
// MAINTAINER NOTE: drizzle-kit emits `CREATE SCHEMA "bbstat";` without
// `IF NOT EXISTS`, which breaks production installs where the DBA pre-created
// the schema. After `make db-generate`, if the initial migration's first
// statement is plain `CREATE SCHEMA "…"`, patch it to `CREATE SCHEMA IF NOT
// EXISTS "…"` (and mirror in apps/backend/schema/). Only the regenerated 0000
// triggers this — incremental migrations don't.
export const bbstatSchema = pgSchema('bbstat');

// Postgres `tsvector` for the commit-message FTS column. Never read from
// TypeScript (derived index target only), and GENERATED ALWAYS … STORED, so
// `data` is `unknown` and the column is read-only.
const tsvector = customType<{ data: unknown; driverData: string; notNull: false; default: false }>({
  dataType() {
    return 'tsvector';
  },
});

export const syncStatusEnum = bbstatSchema.enum('sync_status', ['idle', 'running', 'success', 'failed']);

export const pullRequestStateEnum = bbstatSchema.enum('pull_request_state', [
  'OPEN',
  'MERGED',
  'DECLINED',
  'SUPERSEDED',
]);

// Persona badge assigned to a user by the nightly scoring rollup. NULL on
// `user_score.badge` means "Regular" (no persona matched) or "Dormant"
// (`is_dormant = true`) — the UI distinguishes the two from `is_dormant`,
// not from a separate enum value. Cascade order + thresholds live in
// docs/scoring.md; the badge classifier is the single writer.
export const userBadgeEnum = bbstatSchema.enum('user_badge', [
  'fresh_meat',
  'deep_diver',
  'ai_alex',
  'steady_eddie',
  'batch_betty',
  'cleanup_crew',
]);

// Optional within-badge tier. NULL for non-tiered badges; today only
// `steady_eddie` is tiered, but the column generalizes so other personas
// can be tiered later without another schema change. Thresholds live in
// `apps/backend/src/scoring/constants.ts` and are calibrated against the
// live consistency distribution.
export const userBadgeTierEnum = bbstatSchema.enum('user_badge_tier', ['bronze', 'silver', 'gold']);

// Operator override for the Members classification (users.membership_override).
// NULL = auto-classify; a set value FORCES that status and wins over every
// heuristic. The escape hatch for cases no signal can resolve: a departed
// ex-employee whose org-domain email otherwise reads as an active member
// ('departed'), or a real colleague on a personal email that reads as an
// outsider ('member'). Toggled via POST /admin/users/:id/override + /clear.
export const membershipOverrideEnum = bbstatSchema.enum('membership_override', ['member', 'departed', 'external']);

// `email`: the `<email>` from commits.author.raw, write-once via COALESCE
// (first observed sticks). This is the git-configured email, NOT a verified
// workspace email (BB's members endpoint never returned email). Same person
// may use multiple emails across machines; noreply addresses are filtered at
// ingest so they never poison the column. Plumbed via
// CommitStore.setUserEmailsIfMissing in commits.ts + deepen-backfill.ts.
//
// `is_workspace_member`: TRUE for rows from `/workspaces/{ws}/members`, FALSE
// for rows auto-created during commit ingest (ex-employees, never-members,
// external contributors). Member sync forces TRUE on every current member, so
// a rejoiner flips back. UI mutes out-of-workspace contributors via this flag.
//
// `person_id` — Phase 5 alias-merge layer. NULL = unattached. NOT NULL = an
// alias of canonical `people.id`; the leaderboard / scoring rollup collapses
// aliases through this column. Operator-curated, no auto-detection. ON DELETE
// SET NULL — dissolving a person leaves alias rows intact. The partial index
// targets the "all aliases of person X" lookup; NULL rows don't pollute it.
//
// `is_primary_for_person`: the canonical alias supplying UI defaults
// (display_name fallback, username, mailto, avatar) for its person. ≤1 per
// person (partial unique index); a CHECK nulls the flag when person_id is
// NULL. Lives here rather than `people.primary_user_id` because the latter
// created a circular FK with `users.person_id` that broke pg_dump
// --data-only restores once merges exist.
export const users = bbstatSchema.table(
  'users',
  {
    id: serial('id').primaryKey(),
    bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
    displayName: text('display_name').notNull(),
    username: text('username'),
    email: text('email'),
    isWorkspaceMember: boolean('is_workspace_member').notNull().default(false),
    // Operator override for the Members classification — NULL = auto-classify;
    // a set value forces that membershipStatus and beats every heuristic. Fixes
    // the two cases no signal can resolve: a departed ex-employee whose org
    // email otherwise reads as 'member' (force 'departed'), and a colleague on
    // a personal email that reads as 'external' (force 'member'). Deliberately
    // SEPARATE from is_workspace_member so the member-sync departure
    // reconciliation (which only flips is_workspace_member) never clears an
    // operator decision. Toggled via POST /admin/users/:id/override + /clear.
    membershipOverride: membershipOverrideEnum('membership_override'),
    personId: integer('person_id').references((): AnyPgColumn => people.id, { onDelete: 'set null' }),
    isPrimaryForPerson: boolean('is_primary_for_person').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    personIdIdx: index('users_person_id_idx')
      .on(t.personId)
      .where(sql`${t.personId} IS NOT NULL`),
    // Partial unique index enforcing "≤1 primary alias per person"; NULL-person
    // rows stay out of the index.
    onePrimaryPerPersonIdx: uniqueIndex('users_one_primary_per_person_idx')
      .on(t.personId)
      .where(sql`${t.isPrimaryForPerson} = true AND ${t.personId} IS NOT NULL`),
  }),
);

// Operator-curated identity layer above `users`. One row = one canonical
// human; multiple `users` rows attach via `users.person_id`. Hand-built via
// `/api/admin/people` — no auto-detection. See docs/people.md.
//
// `display_name` is operator-canonical. NULL → "use the primary alias's
// display_name" (the leaderboard view COALESCEs through
// `users.is_primary_for_person`). Set when the primary alias's name isn't the
// right human-facing label.
//
// No `primary_user_id` column by design — it created a circular FK with
// `users.person_id` that breaks pg_dump --data-only restores. Primary lives
// on the `users` side as a flag.
export const people = bbstatSchema.table('people', {
  id: serial('id').primaryKey(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// The curated *tracked* set — non-archived rows are what sync workers walk.
// `tracked-repos.yaml` is a **seed file**, not live config: it controls first-
// discovery inserts and seeds initial `archived`. Once a row exists the DB is
// canonical — discovery syncs do NOT overwrite flags from YAML.
//
// `archived` — soft-retire flag: keep historical data, stop sync work.
// `listTrackedRepositories()` filters `archived = false`. Seeded from YAML;
// flipped via POST /repositories/:ws/:slug/archive. No cascade.
//
// `sync_excluded` — same effect as `archived` but written by the sync layer
// on a permanently-broken state; `sync_exclude_reason` records WHY. Auto-trip
// causes: 'repo-404' (commits endpoint 404 — renamed/deleted upstream),
// 'empty-on-bitbucket' (cold + deepen converged with zero commits),
// 'history-rewritten' (delta walked full history without finding
// last_seen_sha — force-push). Distinct from `archived` so the UI surfaces
// "needs attention" separately and admin recovery has its own lifecycle.
//
// `diff_stats_enabled` was removed in 2026-05 — diff-stat ingest is no longer
// per-repo opt-in; every non-archived non-excluded repo participates and the
// backfill tick uses a global freshness-first pickup. Opt-out goes through
// `archived` or per-file `diff_stats_exclude_patterns`.
export const repositories = bbstatSchema.table('repositories', {
  id: serial('id').primaryKey(),
  bitbucketUuid: text('bitbucket_uuid').notNull().unique(),
  workspace: text('workspace').notNull(),
  project: text('project'),
  slug: text('slug').notNull(),
  fullName: text('full_name').notNull(),
  archived: boolean('archived').notNull().default(false),
  syncExcluded: boolean('sync_excluded').notNull().default(false),
  syncExcludeReason: text('sync_exclude_reason'),
  // Per-repo file-path globs the diff-stat aggregator skips (picomatch,
  // gitignore-style; additive per repo, no global defaults). Empty = sum every
  // entry. Editing is a cheap UPDATE, but applying it to already-ingested
  // commits requires POST /diff-stats/reset (clears diff_stats_synced_at so
  // the backfill tick re-fetches with the new filter).
  diffStatsExcludePatterns: text('diff_stats_exclude_patterns')
    .array()
    .notNull()
    .default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// `diff_stats_synced_at` — resumability marker for per-commit diff-stat
// ingest. NULL until /diffstat/:sha lands; the partial index
// commits_pending_diff_stats_idx keeps the `… IS NULL` pickup query cheap as
// `commits` grows.
//
// `is_merge` mirrors BB's `parents.length > 1`, set at insert. User-facing
// add/del/files aggregates default-exclude merges (a merge inflates per-file
// stats by the full branch delta, dwarfing real authorship).
//
// `files_changed`, `additions`, `deletions` stay at 0 until /diffstat lands;
// the partial index keys the backfill pickup on the NULL `diff_stats_synced_at`.
export const commits = bbstatSchema.table(
  'commits',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    sha: text('sha').notNull(),
    message: text('message').notNull(),
    isMerge: boolean('is_merge').notNull().default(false),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    filesChanged: integer('files_changed').notNull().default(0),
    // Cumulative count of failed `/diffstat/<sha>` fetch attempts. Generic 5xx
    // adds 1; HTTP 555 adds 3 — 555 is a BB compute timeout, a persistent
    // property of the commit shape (heavy file count, deep tree) rather than
    // transient load. At DIFF_STATS_FAILURE_THRESHOLD (3) the orchestrator
    // stamps zeros + diff_stats_synced_at=NOW() to drop the commit from the
    // pickup query for good. The counter survives the stamp so readers can tell
    // "tried 3× and gave up" from "genuinely zero changes" (UI swaps the
    // +/-/files line for an exclamation icon when count >= threshold).
    diffStatsFailureCount: integer('diff_stats_failure_count').notNull().default(0),
    diffStatsSyncedAt: timestamp('diff_stats_synced_at', { withTimezone: true }),
    // Author-snapshot columns, populated at ingest from BB's `author.raw` +
    // `author.user.display_name`. NULL when BB metadata is too thin;
    // `author_email` also NULL for noreply-filtered addresses (parseAuthorEmail).
    // Stored on the commit (not just `users`) because the value is immutable
    // per commit (won't drift on rename) and anonymous rows can still carry the
    // email/name they were pushed with. Read-only after ingest.
    authorEmail: text('author_email'),
    authorDisplayName: text('author_display_name'),
    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    // FTS target for the Activity page's commit-message search. `simple`
    // dictionary (no stemming/stopwords) is predictable across the
    // multilingual / acronym-heavy corpus where an 'english' config would miss
    // non-English vocabulary. GENERATED STORED — stays in lockstep with
    // `message`, no application write.
    messageTsv: tsvector('message_tsv').generatedAlwaysAs(sql`to_tsvector('simple', message)`),
  },
  (t) => ({
    shaRepoUnique: uniqueIndex('commits_sha_repo_unique').on(t.repositoryId, t.sha),
    authorAuthoredIdx: index('commits_author_authored_idx').on(t.authorUserId, t.authoredAt),
    pendingDiffStatsIdx: index('commits_pending_diff_stats_idx')
      .on(t.repositoryId)
      .where(sql`${t.diffStatsSyncedAt} IS NULL`),
    messageTsvIdx: index('commits_message_tsv_idx').using('gin', t.messageTsv),
    // `text_pattern_ops` so the Activity page's hash-prefix search (`sha LIKE
    // 'abc%'`) is index-driven; `commits_sha_repo_unique` on (repository_id,
    // sha) can't serve a SHA-only prefix scan.
    shaPrefixIdx: index('commits_sha_prefix_idx').using('btree', sql`${t.sha} text_pattern_ops`),
  }),
);

// Per-day per-(repo, user) commit rollup, populated after each commit tick
// (dashboard/rollup-store.ts). The dashboard reads this instead of re-scanning
// `commits`, keeping query latency flat.
//
// `author_user_id` nullable: anonymous commits collapse to one row per (day,
// repo) via NULLS NOT DISTINCT on the unique index (Postgres ≥ 15 required) —
// without it we'd accumulate one duplicate per anonymous commit.
//
// `commit_count` is **non-merge only** (user-level rollups sum it as-is);
// `merge_commit_count` is summed alongside ONLY for repo-level displays. The
// split is load-bearing: a merge equals the entire branch delta attributed to
// whoever clicked the button, so counting merges would dominate per-author
// metrics. `additions` / `deletions` are likewise non-merge.
export const commitDaily = bbstatSchema.table(
  'commit_daily',
  {
    day: date('day').notNull(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    commitCount: integer('commit_count').notNull().default(0),
    mergeCommitCount: integer('merge_commit_count').notNull().default(0),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // UNIQUE constraint (not index) because Drizzle 0.36 exposes
    // `.nullsNotDistinct()` on `unique()` but not `uniqueIndex()`. ON CONFLICT
    // targets it by constraint name.
    dayRepoUserUnique: unique('commit_daily_day_repo_user_unique')
      .on(t.day, t.repositoryId, t.authorUserId)
      .nullsNotDistinct(),
    repoDayIdx: index('commit_daily_repo_day_idx').on(t.repositoryId, t.day),
    userDayIdx: index('commit_daily_user_day_idx').on(t.authorUserId, t.day),
  }),
);

// Per-user ShipShow Score rollup, one row per user. Fully recomputed by the
// nightly scoring rollup (scoring/rollup.ts) — never incremental. The
// leaderboard API reads this; nothing scores on the request path. See
// docs/scoring.md for formulas, constants, and the corpus calibration.
//
// `score_*` / `volume_*` sum `score_commit = ln(1+capped_adds) +
// ALPHA*ln(1+capped_dels)` over eligible commits. `score_trending` adds an
// `exp(-ln(2)*age_days/30)` decay so recent activity dominates; `volume_*` are
// undecayed with a hard window cutoff (`volume_all` is the unbounded sum).
//
// Eligible: `is_merge=false AND diff_stats_synced_at IS NOT NULL AND
// diff_stats_failure_count < 3 AND author_user_id IS NOT NULL`. The
// eligible/total ratio is materialized as `coverage_pct` so the UI can flag
// partial-ingest scores without joining `commits`.
//
// `consistency_90d` NULL on cold-start (`active_days_90d < 3`; UI shows "—").
// `is_dormant = (active_days_90d = 0)`. `badge` is the cascaded persona (NULL =
// Regular / Dormant); single writer (the rollup).
export const userScore = bbstatSchema.table(
  'user_score',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),

    // Coverage. `commits_total` includes merges + pending-diff-stat rows so the
    // ratio reflects ingest progress, not just the scoring filter.
    commitsEligible: integer('commits_eligible').notNull().default(0),
    commitsTotal: integer('commits_total').notNull().default(0),
    coveragePct: doublePrecision('coverage_pct').notNull().default(0),

    // Per-dev p95 of raw_churn clipped against the global FLOOR — the cap every
    // per-commit score in this row was computed against.
    p95ChurnCap: integer('p95_churn_cap').notNull().default(0),

    // Decayed global score — default sort key on the leaderboard.
    scoreTrending: doublePrecision('score_trending').notNull().default(0),

    // Un-decayed per-window volume sums.
    volume7d: doublePrecision('volume_7d').notNull().default(0),
    volume30d: doublePrecision('volume_30d').notNull().default(0),
    volume90d: doublePrecision('volume_90d').notNull().default(0),
    volume365d: doublePrecision('volume_365d').notNull().default(0),
    volumeAll: doublePrecision('volume_all').notNull().default(0),

    // Consistency over a fixed 90d window — NULL on cold-start (<3 active
    // days). Decoupled from the volume-window slider on purpose (working style
    // doesn't slide with the recency dial).
    consistency90d: doublePrecision('consistency_90d'),
    activeDays90d: integer('active_days_90d').notNull().default(0),

    // Badge classifier inputs from the 90d eligible commit set.
    medianChurn90d: integer('median_churn_90d').notNull().default(0),
    p95Churn90d: integer('p95_churn_90d').notNull().default(0),

    // Cascade output. NULL = Regular or Dormant (UI distinguishes via
    // `is_dormant`).
    badge: userBadgeEnum('badge'),
    // Within-badge tier. NULL for non-tiered badges and null `badge`. Only
    // steady_eddie tiers today.
    badgeTier: userBadgeTierEnum('badge_tier'),
    isDormant: boolean('is_dormant').notNull().default(false),

    // Tenure — drives the `fresh_meat` cascade entry + a "joined N days ago"
    // hint. From the oldest commit's `authored_at` regardless of eligibility
    // (wall-clock tenure, not scored tenure).
    daysSinceFirstCommit: integer('days_since_first_commit').notNull().default(0),
  },
  (t) => ({
    // NULLS LAST so any future never-scored row sinks to the bottom.
    trendingIdx: index('user_score_trending_idx').on(t.scoreTrending.desc().nullsLast()),
    // 30d is the UI default; other windows skip indexes — 110 rows fits in
    // cache and a full sort is free at this scale.
    volume30dIdx: index('user_score_volume_30d_idx').on(t.volume30d.desc().nullsLast()),
  }),
);

// Per-person ShipShow Score rollup — the alias-merge sibling of `user_score`,
// recomputed against the unioned commit set across every alias of the person.
// Written in parallel with `user_score` (NOT a replacement); shape mirrors it
// column-for-column so the `leaderboard_entries` view can UNION ALL without
// shimming.
//
// Composability across aliases:
//   - score_trending / volume_*: sum (linear in commits)
//   - consistency_90d / p95_churn_cap / median_churn_90d / p95_churn_90d:
//     recomputed against the unioned set (distributional, NOT additive)
//   - active_days_90d: distinct active-day count across aliases
//   - is_dormant: AND across aliases
//   - days_since_first_commit: max across aliases
//   - badge / badge_tier: recomputed against unioned inputs
//
// Workspace-member status at person scope (OR across aliases) lives in the
// `leaderboard_entries` view, not here — it's a property of the alias.
export const personScore = bbstatSchema.table(
  'person_score',
  {
    personId: integer('person_id')
      .primaryKey()
      .references(() => people.id, { onDelete: 'cascade' }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),

    commitsEligible: integer('commits_eligible').notNull().default(0),
    commitsTotal: integer('commits_total').notNull().default(0),
    coveragePct: doublePrecision('coverage_pct').notNull().default(0),

    p95ChurnCap: integer('p95_churn_cap').notNull().default(0),

    scoreTrending: doublePrecision('score_trending').notNull().default(0),

    volume7d: doublePrecision('volume_7d').notNull().default(0),
    volume30d: doublePrecision('volume_30d').notNull().default(0),
    volume90d: doublePrecision('volume_90d').notNull().default(0),
    volume365d: doublePrecision('volume_365d').notNull().default(0),
    volumeAll: doublePrecision('volume_all').notNull().default(0),

    consistency90d: doublePrecision('consistency_90d'),
    activeDays90d: integer('active_days_90d').notNull().default(0),

    medianChurn90d: integer('median_churn_90d').notNull().default(0),
    p95Churn90d: integer('p95_churn_90d').notNull().default(0),

    badge: userBadgeEnum('badge'),
    badgeTier: userBadgeTierEnum('badge_tier'),
    isDormant: boolean('is_dormant').notNull().default(false),

    daysSinceFirstCommit: integer('days_since_first_commit').notNull().default(0),
  },
  (t) => ({
    trendingIdx: index('person_score_trending_idx').on(t.scoreTrending.desc().nullsLast()),
    volume30dIdx: index('person_score_volume_30d_idx').on(t.volume30d.desc().nullsLast()),
  }),
);

export const branches = bbstatSchema.table(
  'branches',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    targetSha: text('target_sha').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoNameUnique: uniqueIndex('branches_repo_name_unique').on(t.repositoryId, t.name),
  }),
);

export const pullRequests = bbstatSchema.table(
  'pull_requests',
  {
    id: serial('id').primaryKey(),
    repositoryId: integer('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    // Numeric PR id within the repo (the BitBucket "id" field, not the UUID)
    bitbucketPrId: integer('bitbucket_pr_id').notNull(),
    title: text('title').notNull(),
    state: pullRequestStateEnum('state').notNull(),
    authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    sourceBranch: text('source_branch').notNull(),
    destinationBranch: text('destination_branch').notNull(),
    sourceSha: text('source_sha'),
    destinationSha: text('destination_sha'),
    commentCount: integer('comment_count').notNull().default(0),
    taskCount: integer('task_count').notNull().default(0),
    bitbucketCreatedAt: timestamp('bitbucket_created_at', { withTimezone: true }).notNull(),
    bitbucketUpdatedAt: timestamp('bitbucket_updated_at', { withTimezone: true }).notNull(),
    bitbucketClosedAt: timestamp('bitbucket_closed_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoPrUnique: uniqueIndex('pull_requests_repo_pr_unique').on(t.repositoryId, t.bitbucketPrId),
    repoStateIdx: index('pull_requests_repo_state_idx').on(t.repositoryId, t.state),
    authorUpdatedIdx: index('pull_requests_author_updated_idx').on(t.authorUserId, t.bitbucketUpdatedAt),
  }),
);

// One row per tracked repository: commit-pull cursor + last-attempt outcome,
// plus the PR-pull cursor + counter. Commit and PR ingest run on independent
// schedules and write disjoint columns. Manual, cron, and webhook triggers all
// converge on the same row — see runSync() in src/sync/runner.ts.
export const syncState = bbstatSchema.table('sync_state', {
  repositoryId: integer('repository_id')
    .primaryKey()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  lastSeenSha: text('last_seen_sha'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
  lastSyncStatus: syncStatusEnum('last_sync_status').notNull().default('idle'),
  lastSyncError: text('last_sync_error'),
  totalCommitsSynced: integer('total_commits_synced').notNull().default(0),
  // PR-sync cursor. PRs walked newest-first by `updated_on`; stores the
  // most-recent ingested `updated_on` + BB numeric PR id for same-second
  // tie-break. NULL on both = cold mode. `pr_last_synced_at` is observational
  // (PR errors land in the tick result + logs, not on the row).
  lastPrUpdatedAt: timestamp('last_pr_updated_at', { withTimezone: true }),
  lastPrId: integer('last_pr_id'),
  prLastSyncedAt: timestamp('pr_last_synced_at', { withTimezone: true }),
  prTotalSynced: integer('pr_total_synced').notNull().default(0),
  // Self-queueing deepen-backfill. `deepen_complete` flips true once we've
  // walked back to the repo's first commit (BB returns no `next`). Until then
  // the per-tick worker picks one repo (ORDER BY deepen_last_run_at NULLS
  // FIRST) and runs one bounded backfill page backwards. Derived queue — just
  // a SELECT each tick, nothing to enqueue/dequeue.
  deepenComplete: boolean('deepen_complete').notNull().default(false),
  deepenLastRunAt: timestamp('deepen_last_run_at', { withTimezone: true }),
  // Retroactive `is_merge` backfill state. `commits.is_merge` was added in
  // V1_7 with DEFAULT false, so pre-V1_7 rows are stuck at false; new commits
  // land correct, so this exists only to drain that backlog. The tick walks BB
  // `/commits` newest-first from `is_merge_backfill_cursor_sha` (NULL = newest)
  // and bulk-UPDATEs by sha via `updateIsMergeBatch`. When the paginator
  // exhausts without hitting the page cap, `is_merge_backfill_complete` flips
  // true. Round-robin via `is_merge_last_run_at`, mirroring the deepen worker.
  isMergeBackfillComplete: boolean('is_merge_backfill_complete').notNull().default(false),
  isMergeBackfillCursorSha: text('is_merge_backfill_cursor_sha'),
  isMergeLastRunAt: timestamp('is_merge_last_run_at', { withTimezone: true }),
  // Anonymous-commit sweep state. The standalone `make dev-resync` runner
  // walks BB `/commits` per repo to attribute commits with `author_user_id IS
  // NULL` (ex-employees / never-members not in `users` at original ingest).
  // `anonymous_sweep_complete` flips true once a pass attributes zero rows (the
  // residual is structurally anonymous). Picker rotation mirrors deepen /
  // is-merge (ORDER BY anonymous_sweep_last_run_at NULLS FIRST WHERE complete =
  // false). Re-arm a repo by manually UPDATEing the flag to false.
  anonymousSweepComplete: boolean('anonymous_sweep_complete').notNull().default(false),
  anonymousSweepLastRunAt: timestamp('anonymous_sweep_last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
