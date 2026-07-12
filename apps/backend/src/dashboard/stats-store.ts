// Dashboard read-side store: interface + Drizzle impl, so route tests can use
// a fake store with no DB.
//
// Commit-aggregation methods read from `commit_daily` (per-day per-repo
// per-author rollup) using UTC day buckets — day buckets are what the
// dashboard means by "last 7 days" and stay cheap at any size.
// `getLatestCommitForRepository` is the only method still reading per-commit
// detail from `commits`; `getActivity` reads commits + PRs directly.

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commits, repositories, syncState, users } from '../db/schema.js';

export interface OverviewStats {
  // Distinct users with at least one attributed commit — matches the Members
  // page roster (a raw count of `users` would include never-committed members).
  contributors: number;
  repositories: number;
  projects: number;
  totalCommits: number;
  commitsLast7Days: number;
  commitsLast30Days: number;
}

export interface LatestCommit {
  sha: string;
  message: string;
  authoredAt: string;
  authorDisplayName: string | null;
  authorBitbucketUuid: string | null;
}

// Dashboard org-wide Top Contributors panel row. Keyed on the merged entity
// (person or unattached user) rather than a bare user_id, so a merged person
// appears once instead of as N alias rows.
export interface TopContributorEntity {
  // 'user' → unattached user; entityId is users.id; link to /users/:id.
  // 'person' → merged person; entityId is people.id; link to /people/:id.
  entityKind: 'user' | 'person';
  entityId: number;
  // Primary-first attached user_ids. Length 1 for user rows. The dashboard
  // activity-filter dropdown uses attachedUserIds[0] — persons filter by their
  // primary alias until multi-actor activity filtering lands.
  attachedUserIds: number[];
  // Primary alias's UUID for person rows; the user's own for user rows.
  bitbucketUuid: string | null;
  displayName: string;
  commits: number;
  last30Days: number[];
  additionsWindow: number;
  deletionsWindow: number;
  reposWindow: number;
  momentum: number | null;
  consistency90d: number | null;
}

export interface UserSummary {
  user: {
    id: number;
    bitbucketUuid: string;
    displayName: string;
    email: string | null;
    // Badge + tier — null when the user has no user_score row yet (between
    // member sync and the next commits-sync tick), or when the classifier
    // returned null (dormant or no match).
    badge: UserBadge | null;
    badgeTier: UserBadgeTier | null;
    // When this user is attached to a person, carries the person's id +
    // canonical display_name (for the "Part of: <displayName>" banner). Null
    // when unattached. display_name COALESCEs through the primary alias like
    // the leaderboard_entries view does.
    person: { id: number; displayName: string } | null;
  };
  // Sibling aliases merged into the same person, this account excluded. Empty
  // for an unattached user. Same shape as PersonSummary.attachedUsers.
  linkedAccounts: Array<{
    id: number;
    bitbucketUuid: string;
    displayName: string;
    username: string | null;
    email: string | null;
    isPrimary: boolean;
    lastActiveAt: string | null;
  }>;
  totals: {
    commits7d: number;
    commits30d: number;
    commitsAllTime: number;
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
    // Distinct repositories this user has ever landed a commit in (bounded by
    // deepen-backfill progress).
    repositoriesAllTime: number;
  };
  // Last 365 calendar days, oldest first; zero-commit days omitted (frontend
  // backfills gaps when rendering the heatmap).
  dailyCommits: Array<{ date: string; commits: number }>;
  // Top 5 repos this user committed to in the last 30 days.
  topRepos: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    project: string | null;
    commits: number;
    syncStatus: RepoSyncStatus;
    // This user's last-30-day per-repo code-change footprint, merges excluded.
    // File count is intentionally NOT aggregated — SUM(files_changed) across
    // commits double-counts paths edited repeatedly.
    additions30d: number;
    deletions30d: number;
  }>;
}

// The Person detail page's read shape. Mirrors UserSummary except the identity
// carries an `attachedUsers` roster of the underlying aliases, and every
// aggregate is computed across the unioned commit set of those aliases (so the
// frontend can share the existing chart components).
export interface PersonSummary {
  person: {
    id: number;
    // people.display_name with COALESCE fallback to primary alias's
    // display_name (same fallback as leaderboard_entries).
    displayName: string;
    // From the primary alias (NULL when no alias is flagged primary).
    bitbucketUuid: string | null;
    email: string | null;
    // From person_score. Null when no eligible commits across any alias yet.
    badge: UserBadge | null;
    badgeTier: UserBadgeTier | null;
  };
  // Every alias attached to this person, primary-first.
  attachedUsers: Array<{
    id: number;
    bitbucketUuid: string;
    displayName: string;
    username: string | null;
    email: string | null;
    isPrimary: boolean;
    // MAX(commits.authored_at) for this single alias — null if no commits yet.
    // The person's own "last active" is the max across all aliases; this is
    // the per-account split.
    lastActiveAt: string | null;
  }>;
  totals: {
    commits7d: number;
    commits30d: number;
    commitsAllTime: number;
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
    repositoriesAllTime: number;
  };
  // Last 365 days; zero-commit days omitted (heatmap backfills client-side).
  dailyCommits: Array<{ date: string; commits: number }>;
  // Top 5 repos by last-30-day commit count across the unioned alias set.
  topRepos: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    project: string | null;
    commits: number;
    syncStatus: RepoSyncStatus;
    additions30d: number;
    deletions30d: number;
  }>;
}

export interface ProjectStats {
  project: string;
  totals: {
    commits7d: number;
    commits30d: number;
    // Distinct contributors over the last 30 days, counted per ENTITY (a
    // merged person's aliases collapse to one).
    contributorCount30d: number;
    repositoryCount: number;
  };
  // Last 365 calendar days, oldest first; zero-commit days omitted. Aggregates
  // across every repo carrying this project's key.
  dailyCommits: Array<{ date: string; commits: number }>;
  // Entity-keyed contributor table (person-aware), aggregated across every repo
  // carrying this project's key. A person's aliases collapse into one row.
  topContributors: RepoContributorEntity[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
    // Per-repo distinct contributors, counted per entity.
    contributors30d: number;
    lastCommitAt: string | null;
    syncStatus: RepoSyncStatus;
  }>;
}

export interface RepoActivity {
  repository: {
    workspace: string;
    slug: string;
    fullName: string;
    // Project key the repo lives under, or null if unassigned. Surfaced so the
    // repo-detail page can breadcrumb to its parent project without a separate
    // lookup.
    project: string | null;
    syncStatus: RepoSyncStatus;
  };
  // Last 365 calendar days, oldest first; zero-commit days omitted.
  dailyCommits: Array<{ date: string; commits: number; additions: number; deletions: number }>;
  // Per-window code-change summary, merges excluded (7d/30d = last N calendar
  // days). Reads zero when no diff-stat ingest has landed yet (transient).
  diffStats: {
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
  };
  // Contributors active in the last 30 days, commit count desc, keyed on the
  // merged ENTITY (a person's aliases collapse into one row). `last30Days` is
  // repo-scoped (this entity's commits in THIS repo). Diff-stat fields are
  // 30-day, exclude merges, read zero before diff-stat ingest lands.
  contributors: RepoContributorEntity[];
}

// Repo detail "Contributors — last 30 days" row, keyed on the merged entity.
// Mirrors TopContributorEntity's identity fields but omits scoring and the
// distinct-repo count (it's one repo by definition).
export interface RepoContributorEntity {
  entityKind: 'user' | 'person';
  entityId: number;
  // Primary-first attached user_ids; length 1 for unattached users.
  attachedUserIds: number[];
  bitbucketUuid: string | null;
  displayName: string;
  commits: number;
  // Repo-scoped 30-day sparkline (this entity's commits in THIS repo).
  last30Days: number[];
  // 30-day adds/dels in this repo across the entity's aliases, merges excluded.
  additions30d: number;
  deletions30d: number;
}

export interface ActivityRepository {
  workspace: string;
  slug: string;
  fullName: string;
}

export interface ActivityAuthor {
  userId: number;
  displayName: string;
  bitbucketUuid: string;
}

export interface ActivityCommit {
  kind: 'commit';
  sha: string;
  message: string;
  additions: number;
  deletions: number;
  // Distinct file paths touched (= rows in BB's /diffstat response). 0 when
  // diff-stats haven't been fetched yet (diff_stats_synced_at IS NULL).
  filesChanged: number;
  // True when the commit has more than one parent. Merges' additions/deletions
  // include the entire merged-branch delta and shouldn't be read as authorship
  // volume; per-user adds/dels aggregates default-exclude is_merge rows.
  isMerge: boolean;
  // True when the diff-stats orchestrator gave up (diff_stats_failure_count >=
  // threshold). additions/deletions/filesChanged all read 0 here (the
  // stamp-with-zeros pattern that drops the commit out of the pickup query), so
  // renderers MUST branch on this flag rather than treating zeros as a small
  // commit — otherwise the commit looks like a no-op.
  diffStatsUnavailable: boolean;
  repository: ActivityRepository;
  author: ActivityAuthor | null;
  // commits.authored_at, ISO 8601.
  occurredAt: string;
}

export interface ActivityPullRequest {
  kind: 'pr';
  prId: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  sourceBranch: string;
  destinationBranch: string;
  repository: ActivityRepository;
  author: ActivityAuthor | null;
  // pull_requests.bitbucket_updated_at — chosen over created_on so PR
  // state changes (merge, decline, comment churn) resurface in the feed.
  occurredAt: string;
}

export type ActivityEntry = ActivityCommit | ActivityPullRequest;

// Activity-feed actor filter. A `user` matches that one `users.id`; a `person`
// expands to every alias attached to the person, so a merged contributor's
// commits + PRs across all accounts show under one filter.
export type ActivityActor = { kind: 'user' | 'person'; id: number };

export interface ActivityFilters {
  // All filters are AND-combinable; null means "no filter on this axis".
  actor: ActivityActor | null;
  repo: { workspace: string; slug: string } | null;
  project: string | null;
  // Cursor / range upper bound — entries with occurredAt strictly less than
  // this. Null on the first page; later pages pass the last entry's occurredAt.
  before: Date | null;
  // Date-range lower bound (inclusive). PRs use bitbucket_updated_at against it.
  after: Date | null;
  // Lowercased hex commit-SHA prefix (1–40 chars). When set, the PR branch is
  // suppressed since PRs don't carry a SHA.
  hashPrefix: string | null;
  // Free-text search. Commits use Postgres FTS over `message_tsv`
  // (`plainto_tsquery('simple', …)`); PRs use ILIKE on `title`.
  message: string | null;
  // Default 50, max 200 — enforced at the route layer.
  limit: number;
  // Offset for the Activity page's First/Last navigation. Zero for the embedded
  // cursor-paginated feed (which uses `before` instead).
  offset: number;
}

// Derived sync health for a tracked repository, surfaced as a status icon.
// Maps `repositories.sync_excluded` + `sync_state.last_sync_status`:
//   - sync_excluded=true                                  → 'excluded'
//   - last_sync_status='failed'                           → 'error'
//   - 'success'/'running' + last_synced_at set            → 'ok'
//   - 'idle' + null timestamp                             → 'never'
// Closed-set string (not the raw enum) so the frontend needn't know 'running'
// as a separate state — a mid-flight tick is healthy here. `excluded` outranks
// `error` because the cause is durable (rename / empty / force-push) and
// recovery is a specific admin action, not a wait-and-retry. 'empty' is a
// BENIGN exclusion (nothing to sync), kept distinct from 'excluded' so the UI
// doesn't flag empty repos as problems in the Repositories Issues tab.
export type RepoSyncStatus = 'ok' | 'error' | 'never' | 'excluded' | 'empty';

// One row on the /members leaderboard — an unattached user or a merged person,
// with every attached alias collapsed into its parent person via
// leaderboard_entries. The per-user UserSummary page still exists at /users/:id.
//
// Anonymous / unmatched-author commits are excluded. Window-zero rows still
// appear (a quiet week shouldn't empty the list); never-committed entities are
// filtered out at the SQL level.
export interface WorkspaceMember {
  // 'user' → unattached `users` row, entityId is user_id, link /users/:id.
  // 'person' → merged `people` row, entityId is person_id, link /people/:id.
  entityKind: 'user' | 'person';
  entityId: number;
  // Person rows: primary alias's `users.bitbucket_uuid`. User rows: own UUID.
  // Null only when a person has aliases but none is flagged primary and no
  // auto-election happened (the is_primary_for_person LEFT JOIN returns NULL).
  bitbucketUuid: string | null;
  // Person rows: people.display_name COALESCEd to the primary alias's name (via
  // leaderboard_entries). User rows: the user's own.
  displayName: string;
  username: string | null;
  // Git-author email captured from commits.author.raw at ingest, write-once on
  // the alias (primary alias for person rows). NOT a verified workspace email —
  // see users.email in schema.ts.
  email: string | null;
  // Person rows: OR across aliases (true iff any alias is a workspace member).
  // User rows: own flag. Drives muted styling on the frontend.
  isWorkspaceMember: boolean;
  // Three-way membership provenance, computed server-side so the Members labels
  // and the leaderboard filter share one source of truth. Precedence — a set
  // `membership_override` (operator, POST /admin/users/:id/override) wins over
  // every heuristic below:
  //   member   — override='member' OR is_workspace_member OR a merged person OR
  //              an org-email-domain account (ORG_EMAIL_DOMAINS).
  //   departed — override='departed' OR a lone account that WAS in the member
  //              roster (username set, the member-sync-only signal) but no longer.
  //   external — override='external' OR a lone, non-org-email account with no
  //              member signal (fork imports / outsiders).
  // Only `member` ranks on the leaderboards; departed + external are excluded.
  membershipStatus: 'member' | 'departed' | 'external';
  // user_ids attached to this entity, primary-first. Length 1 for user rows.
  // Drives the "merged from N accounts" pill and per-alias SSE invalidation on
  // the frontend.
  attachedUserIds: number[];
  // Search-only concatenation of EVERY attached alias's name / username / email
  // (the displayed identity only carries the primary's). Lets the Members table
  // + ActorPicker find a merged person by any linked account. Not rendered.
  aliasSearch: string;
  // Per-window commit + distinct-repo aggregates. Both windows ship in one
  // round-trip so the table's `{commits} ({repos})` cells don't re-query on
  // toggle. additions/deletions were dropped when the +/- column came off.
  commits7d: number;
  repos7d: number;
  commits30d: number;
  repos30d: number;
  commitsAllTime: number;
  reposAllTime: number;
  // MAX(commits.authored_at) across this member's commits. Null is unreachable
  // here (the filter requires commitsAllTime > 0) but typed to match the source.
  lastActiveAt: string | null;
  // Length 30, oldest-first, zeros for empty days. Same shape as
  // TopContributorEntity.last30Days.
  last30Days: number[];
  // Score columns (docs/scoring.md), LEFT-JOINed from user_score — null/false
  // when the first user_score row hasn't been written yet. `scoreTrending` is
  // the default leaderboard sort key.
  scoreTrending: number | null;
  consistency90d: number | null;
  badge: UserBadge | null;
  // Within-persona tier — currently only `steady_eddie`; null otherwise.
  badgeTier: UserBadgeTier | null;
  isDormant: boolean;
}

// Mirrors `bbstat.user_badge` enum in schema.ts. Keep in lockstep with
// apps/backend/src/scoring/badge.ts `Badge` and the frontend mirror in
// apps/frontend/src/api/client.ts.
export type UserBadge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

// Mirrors `bbstat.user_badge_tier` enum + `BadgeTier` in
// apps/backend/src/scoring/badge.ts.
export type UserBadgeTier = 'bronze' | 'silver' | 'gold';

export interface TrackedRepositorySummary {
  workspace: string;
  slug: string;
  fullName: string;
  // Project key as stored on repositories.project (null for unassigned repos).
  project: string | null;
  commits30d: number;
  // Distinct non-null author_user_id values active in the last 30 days —
  // "developers who landed code", anonymous authors excluded.
  contributors30d: number;
  // Code-change volume over 30 days, merges EXCLUDED (same predicate as the
  // repo-detail page). Reads zero before diff-stat ingest lands (transient).
  additions30d: number;
  deletions30d: number;
  lastCommitAt: string | null;
  syncStatus: RepoSyncStatus;
  // True when the repo is soft-retired (repositories.archived). Lets the UI
  // badge it so a stale sync status reads as "retired", not a live error.
  archived: boolean;
}

export interface StatsStore {
  getOverview(): Promise<OverviewStats>;
  // Returns null when the repo isn't tracked or has no commits ingested yet.
  // Doesn't distinguish the two — the dashboard treats them the same ("—").
  getLatestCommitForRepository(workspace: string, slug: string): Promise<LatestCommit | null>;
  // Top N developers by commit count over the trailing window, anonymous
  // authors excluded. Each row carries a 30-day commit-count sparkline.
  getTopContributors(windowDays: number, limit?: number): Promise<TopContributorEntity[]>;

  // Returns null when the user id doesn't exist. An existing user with no
  // commits returns a populated summary with all-zero totals and empty arrays.
  getUserSummary(userId: number): Promise<UserSummary | null>;
  // Aggregates across every alias attached to the person. Returns null when no
  // `people` row exists with this id.
  getPersonSummary(personId: number): Promise<PersonSummary | null>;
  // Returns null when no repositories carry the given project key. An empty
  // project (no commits across its repos) returns zero totals and empty arrays.
  getProjectStats(projectKey: string): Promise<ProjectStats | null>;
  // Returns null when the repo isn't tracked. A tracked repo with no commits
  // returns empty arrays.
  getRepositoryActivity(workspace: string, slug: string): Promise<RepoActivity | null>;
  // All tracked repositories, ordered by most-recent activity. The dashboard
  // renders this as the Repositories panel and groups by `project` client-side
  // to drive the Projects panel.
  listTrackedRepositoriesWithStats(): Promise<TrackedRepositorySummary[]>;
  // Workspace member roster for /members. One row per user with at least one
  // ingested commit; window-zero rows still appear. Anonymous authors excluded.
  // Pagination + fuzzy-search run client-side over the full payload (fits one
  // round-trip). No window parameter — both 7d and 30d aggregates ship per row.
  listWorkspaceMembers(): Promise<WorkspaceMember[]>;

  // Unified activity feed: UNION ALL of commits + PRs, ordered by `occurredAt
  // DESC` then `kind, id DESC` so ties break deterministically (otherwise
  // pagination can skip / duplicate). Read directly from Postgres — list
  // endpoints bypass Redis (Redis is user-summary only).
  getActivity(filters: ActivityFilters): Promise<ActivityEntry[]>;

  // 365-day daily commit aggregate for the Activity page heatmap; zero-commit
  // days omitted. Filterable by actor / repo / project; date range, hash, and
  // message search are intentionally ignored — the heatmap always answers
  // "what does the last year look like for this slice?".
  getActivityDaily(filters: ActivityDailyFilters): Promise<DailyCommitPoint[]>;

  // Total entries matching the filter set (commits + PRs union), for the
  // "Page X of Y" indicator. Same filter shape as getActivity but limit /
  // offset are ignored.
  getActivityCount(filters: ActivityFilters): Promise<number>;

  // Top-N repos by commits in the window, each with its top-M contributors.
  // Powers the Projects page sunburst (slices = repos, bands = contributors).
  // Reads commit_daily so it stays cheap.
  getRepoContributorBreakdown(opts: RepoContributorBreakdownOptions): Promise<RepoContributorBreakdown[]>;
}

export interface RepoContributorBreakdownOptions {
  windowDays: number;
  topRepos: number;
  topPerRepo: number;
  // Optional project scope — when set, only repos under this key contribute to
  // the top-N pool. Used by the project detail page's sunburst.
  project: string | null;
}

export interface RepoContributorBreakdown {
  workspace: string;
  slug: string;
  fullName: string;
  project: string | null;
  // Total window commits across included contributors. Anonymous authors are
  // excluded, so this can be slightly smaller than the dashboard `commits30d`.
  // Invariant to the person grouping below — summing commits doesn't care how
  // contributors are keyed.
  commits: number;
  // Contributor bands keyed per ENTITY — a merged person's aliases collapse
  // into one band.
  contributors: Array<{
    entityKind: 'user' | 'person';
    entityId: number;
    displayName: string;
    commits: number;
  }>;
}

export interface ActivityDailyFilters {
  actor: ActivityActor | null;
  repo: { workspace: string; slug: string } | null;
  project: string | null;
}

export interface DailyCommitPoint {
  date: string; // YYYY-MM-DD
  commits: number;
}

export interface StatsStoreOptions {
  // Org email domains (lowercased) for the Members membership classification.
  // A contributor at one of these domains is treated as a workspace member
  // (never "external"), even when their commit account isn't in the BB member
  // roster and isn't merged. Empty disables the heuristic (only flagged /
  // merged / manually-included accounts count). Wired from config.ORG_EMAIL_DOMAINS.
  orgEmailDomains?: readonly string[];
}

export function createDrizzleStatsStore(db: Database, options: StatsStoreOptions = {}): StatsStore {
  const orgDomains: string[] = [...(options.orgEmailDomains ?? [])];
  // Bind the domains as ONE comma-joined string param and split it back into an
  // array inside SQL. A bare `${array}` interpolation makes drizzle emit a
  // scalar bind, which Postgres rejects with "malformed array literal". Domains
  // never contain commas (config validates trimmed hostnames), so this is safe.
  const orgDomainsCsv = orgDomains.join(',');

  // Shared membership classification, computed once so the /members labels and
  // the leaderboard filter can never diverge. Both assume the leaderboard_entries
  // row is aliased `le`.
  //   orgDomainMatch      — the row's email is at a configured org domain.
  //   ranksAsMember       — leaderboard-inclusion predicate (membershipStatus='member').
  //   membershipStatusExpr — the 3-way label emitted to the Members roster.
  // Precedence (see WorkspaceMember.membershipStatus): operator override →
  // flag → merged person → member-roster history (username) → org email →
  // external. A set `membership_override` wins over every heuristic.
  const orgDomainMatch =
    orgDomains.length === 0
      ? sql`false`
      : sql`lower(split_part(le.email, '@', 2)) = ANY(string_to_array(${orgDomainsCsv}, ','))`;
  const autoIsMember = sql`(le.is_workspace_member OR le.entity_kind = 'person' OR (le.username IS NULL AND ${orgDomainMatch}))`;
  const ranksAsMember = sql`(le.membership_override = 'member' OR (le.membership_override IS NULL AND ${autoIsMember}))`;
  const membershipStatusExpr = sql`CASE
        WHEN le.membership_override IS NOT NULL THEN le.membership_override::text
        WHEN le.is_workspace_member THEN 'member'
        WHEN le.entity_kind = 'person' THEN 'member'
        WHEN le.username IS NOT NULL THEN 'departed'
        WHEN ${orgDomainMatch} THEN 'member'
        ELSE 'external'
      END`;

  return {
    async getOverview() {
      // totalCommits / commitsLast7Days / contributors read from commit_daily
      // so this stays cheap. `contributors` is counted per ENTITY (a merged
      // person collapses its aliases into one) to match the Members roster.
      const [contributorsRows, reposRows, projectsRows, totalCommitsRows, recentCommitsRows] = await Promise.all([
        db.execute<{ contributors: number }>(sql`
          SELECT count(*)::int AS contributors FROM (
            SELECT
              CASE WHEN u.person_id IS NULL THEN 'u:' || u.id::text ELSE 'p:' || u.person_id::text END AS entity
            FROM commit_daily cd
            JOIN users u ON u.id = cd.author_user_id
            WHERE cd.author_user_id IS NOT NULL
            GROUP BY entity
            HAVING sum(cd.commit_count) > 0
          ) e
        `),
        db.select({ count: sql<number>`count(*)::int` }).from(repositories),
        db
          .select({ count: sql<number>`count(distinct project)::int` })
          .from(repositories)
          .where(isNotNull(repositories.project)),
        db.execute<{ total_commits: number }>(sql`
          SELECT COALESCE(sum(commit_count), 0)::int AS total_commits FROM commit_daily
        `),
        db.execute<{ commits_last_7_days: number; commits_last_30_days: number }>(sql`
          SELECT
            COALESCE(sum(commit_count) FILTER (WHERE day >= current_date - 6), 0)::int AS commits_last_7_days,
            COALESCE(sum(commit_count) FILTER (WHERE day >= current_date - 29), 0)::int AS commits_last_30_days
          FROM commit_daily WHERE day >= current_date - 29
        `),
      ]);
      return {
        contributors: contributorsRows.rows[0]?.contributors ?? 0,
        repositories: reposRows[0]?.count ?? 0,
        projects: projectsRows[0]?.count ?? 0,
        totalCommits: totalCommitsRows.rows[0]?.total_commits ?? 0,
        commitsLast7Days: recentCommitsRows.rows[0]?.commits_last_7_days ?? 0,
        commitsLast30Days: recentCommitsRows.rows[0]?.commits_last_30_days ?? 0,
      };
    },

    async getLatestCommitForRepository(workspace, slug) {
      const rows = await db
        .select({
          sha: commits.sha,
          message: commits.message,
          authoredAt: commits.authoredAt,
          authorDisplayName: users.displayName,
          authorBitbucketUuid: users.bitbucketUuid,
        })
        .from(commits)
        .innerJoin(repositories, eq(commits.repositoryId, repositories.id))
        .leftJoin(users, eq(commits.authorUserId, users.id))
        .where(and(eq(repositories.workspace, workspace), eq(repositories.slug, slug)))
        .orderBy(desc(commits.authoredAt))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        sha: row.sha,
        message: row.message,
        authoredAt: row.authoredAt.toISOString(),
        authorDisplayName: row.authorDisplayName,
        authorBitbucketUuid: row.authorBitbucketUuid,
      };
    },

    async getTopContributors(windowDays, limit = 10) {
      // Keyed on (entity_kind, entity_id) — aliases collapse into their person.
      // The JOIN to users excludes anonymous-author rows. Window is `windowDays`
      // UTC day buckets ending today.
      //
      // The ::int cast on the bound param is load-bearing: without it Postgres
      // resolves `current_date - $1` via the `date - date` overload (yielding
      // integer), then `day >= integer` fails to resolve.
      //
      // Identity + momentum (the sort key) come from leaderboard_entries. The
      // `spark` CTE derives the 30-day per-entity sparkline by cross-joining a
      // 30-day series and LEFT JOINing commit_daily so missing days become zero.
      const rows = await db.execute<{
        entity_kind: 'user' | 'person';
        entity_id: number;
        attached_user_ids: number[];
        bitbucket_uuid: string | null;
        display_name: string;
        commits: number;
        additions_window: number;
        deletions_window: number;
        repos_window: number;
        last_30_days: number[];
        momentum: number | null;
        consistency_90d: number | null;
      }>(sql`
        WITH entity_commits AS (
          SELECT
            CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
            CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
            cd.commit_count,
            cd.additions,
            cd.deletions,
            cd.repository_id,
            cd.day
          FROM commit_daily cd
          JOIN users u ON u.id = cd.author_user_id
        ),
        windowed AS (
          SELECT
            entity_kind,
            entity_id,
            sum(commit_count)::int AS commits,
            sum(additions)::int AS additions_window,
            sum(deletions)::int AS deletions_window,
            count(DISTINCT repository_id)::int AS repos_window
          FROM entity_commits
          WHERE day >= current_date - ${windowDays - 1}::int
          GROUP BY entity_kind, entity_id
        ),
        top AS (
          SELECT
            w.entity_kind,
            w.entity_id,
            w.commits,
            w.additions_window,
            w.deletions_window,
            w.repos_window,
            le.bitbucket_uuid,
            le.display_name,
            le.score_trending,
            le.consistency_90d
          FROM windowed w
          JOIN leaderboard_entries le
            ON le.entity_kind = w.entity_kind AND le.entity_id = w.entity_id
           -- Leaderboard ranks workspace members only (membershipStatus='member':
           -- flagged, manually-included, merged persons, and org-email accounts).
           -- Departed ex-members and external contributors drop off; they stay
           -- visible on the /members roster under their own filters.
           AND ${ranksAsMember}
          ORDER BY le.score_trending DESC NULLS LAST, w.commits DESC
          LIMIT ${limit}
        ),
        daily AS (
          SELECT
            CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
            CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
            cd.day,
            sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN users u ON u.id = cd.author_user_id
          WHERE cd.day >= current_date - 29
          GROUP BY entity_kind, entity_id, cd.day
        ),
        spark AS (
          SELECT
            t.entity_kind,
            t.entity_id,
            array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
          FROM top t
          CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval)
            AS sd(day)
          LEFT JOIN daily
            ON daily.entity_kind = t.entity_kind
           AND daily.entity_id = t.entity_id
           AND daily.day = sd.day::date
          GROUP BY t.entity_kind, t.entity_id
        )
        SELECT
          t.entity_kind,
          t.entity_id,
          CASE
            WHEN t.entity_kind = 'person' THEN (
              SELECT array_agg(u.id ORDER BY u.is_primary_for_person DESC, u.id)
              FROM users u
              WHERE u.person_id = t.entity_id
            )
            ELSE ARRAY[t.entity_id]
          END AS attached_user_ids,
          t.bitbucket_uuid,
          t.display_name,
          t.commits,
          t.additions_window,
          t.deletions_window,
          t.repos_window,
          spark.last_30_days,
          t.score_trending AS momentum,
          t.consistency_90d
        FROM top t
        JOIN spark ON spark.entity_kind = t.entity_kind AND spark.entity_id = t.entity_id
        ORDER BY t.score_trending DESC NULLS LAST, t.commits DESC
      `);
      return rows.rows.map((r) => ({
        entityKind: r.entity_kind,
        entityId: r.entity_id,
        attachedUserIds: r.attached_user_ids,
        bitbucketUuid: r.bitbucket_uuid,
        displayName: r.display_name,
        commits: r.commits,
        last30Days: r.last_30_days,
        additionsWindow: r.additions_window,
        deletionsWindow: r.deletions_window,
        reposWindow: r.repos_window,
        momentum: r.momentum,
        consistency90d: r.consistency_90d,
      }));
    },

    async getUserSummary(userId) {
      // The optional people JOIN surfaces the "Part of: <person>" banner. The
      // COALESCE mirrors leaderboard_entries' display_name fallback: operator
      // override → primary alias's name → null.
      const userRows = await db.execute<{
        id: number;
        bitbucket_uuid: string;
        display_name: string;
        email: string | null;
        badge: UserBadge | null;
        badge_tier: UserBadgeTier | null;
        person_id: number | null;
        person_display_name: string | null;
      }>(sql`
        SELECT
          u.id, u.bitbucket_uuid, u.display_name, u.email,
          us.badge, us.badge_tier,
          u.person_id,
          CASE
            WHEN u.person_id IS NULL THEN NULL
            ELSE COALESCE(
              p.display_name,
              (
                SELECT pu.display_name
                FROM users pu
                WHERE pu.person_id = u.person_id
                ORDER BY pu.is_primary_for_person DESC, pu.id
                LIMIT 1
              )
            )
          END AS person_display_name
        FROM users u
        LEFT JOIN user_score us ON us.user_id = u.id
        LEFT JOIN people p ON p.id = u.person_id
        WHERE u.id = ${userId}
        LIMIT 1
      `);
      const userRow = userRows.rows[0];
      if (userRow === undefined) return null;
      const user = {
        id: userRow.id,
        bitbucketUuid: userRow.bitbucket_uuid,
        displayName: userRow.display_name,
        email: userRow.email,
        badge: userRow.badge,
        badgeTier: userRow.badge_tier,
        person:
          userRow.person_id === null ? null : { id: userRow.person_id, displayName: userRow.person_display_name ?? '' },
      };

      // Sibling aliases merged into the same person (this user excluded).
      // Skipped entirely (resolves empty) when this account isn't merged.
      const linkedAccountsPromise =
        userRow.person_id === null
          ? Promise.resolve({
              rows: [] as Array<{
                id: number;
                bitbucket_uuid: string;
                display_name: string;
                username: string | null;
                email: string | null;
                is_primary: boolean;
                last_active_at: string | Date | null;
              }>,
            })
          : db.execute<{
              id: number;
              bitbucket_uuid: string;
              display_name: string;
              username: string | null;
              email: string | null;
              is_primary: boolean;
              last_active_at: string | Date | null;
            }>(sql`
              SELECT
                u.id, u.bitbucket_uuid, u.display_name, u.username, u.email,
                u.is_primary_for_person AS is_primary,
                (SELECT max(c.authored_at) FROM commits c WHERE c.author_user_id = u.id) AS last_active_at
              FROM users u
              WHERE u.person_id = ${userRow.person_id} AND u.id <> ${userId}
              ORDER BY u.is_primary_for_person DESC, u.id ASC
            `);

      const [totalsRows, dailyRows, topRepoRows, linkedAccountsRows] = await Promise.all([
        db.execute<{
          commits_7d: number | null;
          commits_30d: number | null;
          commits_all_time: number | null;
          additions_7d: number | null;
          deletions_7d: number | null;
          additions_30d: number | null;
          deletions_30d: number | null;
          repositories_all_time: number | null;
        }>(sql`
          SELECT
            sum(commit_count) FILTER (WHERE day >= current_date - 6)::int AS commits_7d,
            sum(commit_count) FILTER (WHERE day >= current_date - 29)::int AS commits_30d,
            sum(commit_count)::int AS commits_all_time,
            sum(additions) FILTER (WHERE day >= current_date - 6)::int AS additions_7d,
            sum(deletions) FILTER (WHERE day >= current_date - 6)::int AS deletions_7d,
            sum(additions) FILTER (WHERE day >= current_date - 29)::int AS additions_30d,
            sum(deletions) FILTER (WHERE day >= current_date - 29)::int AS deletions_30d,
            count(DISTINCT repository_id)::int AS repositories_all_time
          FROM commit_daily
          WHERE author_user_id = ${userId}
        `),
        db.execute<{ date: string; commits: number }>(sql`
          SELECT day::text AS date, sum(commit_count)::int AS commits
          FROM commit_daily
          WHERE author_user_id = ${userId} AND day >= current_date - 364
          GROUP BY day
          ORDER BY day
        `),
        db.execute<{
          workspace: string;
          slug: string;
          full_name: string;
          project: string | null;
          commits: number;
          last_sync_status: 'idle' | 'running' | 'success' | 'failed' | null;
          last_synced_at: string | Date | null;
          sync_excluded: boolean;
          additions_30d: number;
          deletions_30d: number;
        }>(sql`
          SELECT
            r.workspace, r.slug, r.full_name, r.project,
            sum(cd.commit_count)::int AS commits,
            ss.last_sync_status, ss.last_synced_at,
            r.sync_excluded,
            COALESCE(ds.additions_30d, 0) AS additions_30d,
            COALESCE(ds.deletions_30d, 0) AS deletions_30d
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          LEFT JOIN sync_state ss ON ss.repository_id = r.id
          LEFT JOIN (
            SELECT
              repository_id,
              sum(additions)::int AS additions_30d,
              sum(deletions)::int AS deletions_30d
            FROM commits
            WHERE author_user_id = ${userId}
              AND authored_at >= (current_date - 29)::timestamp
              AND NOT is_merge
            GROUP BY repository_id
          ) ds ON ds.repository_id = r.id
          WHERE cd.author_user_id = ${userId} AND cd.day >= current_date - 29
          GROUP BY r.id, r.workspace, r.slug, r.full_name, r.project,
                   ss.last_sync_status, ss.last_synced_at, r.sync_excluded,
                   ds.additions_30d, ds.deletions_30d
          ORDER BY sum(cd.commit_count) DESC
          LIMIT 5
        `),
        linkedAccountsPromise,
      ]);

      const t = totalsRows.rows[0];
      return {
        user,
        linkedAccounts: linkedAccountsRows.rows.map((r) => ({
          id: r.id,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          username: r.username,
          email: r.email,
          isPrimary: r.is_primary,
          lastActiveAt:
            r.last_active_at === null
              ? null
              : typeof r.last_active_at === 'string'
                ? new Date(r.last_active_at).toISOString()
                : r.last_active_at.toISOString(),
        })),
        totals: {
          commits7d: t?.commits_7d ?? 0,
          commits30d: t?.commits_30d ?? 0,
          commitsAllTime: t?.commits_all_time ?? 0,
          additions7d: t?.additions_7d ?? 0,
          deletions7d: t?.deletions_7d ?? 0,
          additions30d: t?.additions_30d ?? 0,
          deletions30d: t?.deletions_30d ?? 0,
          repositoriesAllTime: t?.repositories_all_time ?? 0,
        },
        dailyCommits: dailyRows.rows.map((r) => ({ date: r.date, commits: r.commits })),
        topRepos: topRepoRows.rows.map((r) => ({
          workspace: r.workspace,
          slug: r.slug,
          fullName: r.full_name,
          project: r.project,
          commits: r.commits,
          syncStatus: deriveSyncStatus(r.last_sync_status, r.last_synced_at, r.sync_excluded),
          additions30d: r.additions_30d,
          deletions30d: r.deletions_30d,
        })),
      };
    },

    async getPersonSummary(personId) {
      // Identity + badge from people + person_score; the primary alias supplies
      // BB UUID and email fallbacks. display_name COALESCE mirrors
      // leaderboard_entries (operator override beats the primary alias's name).
      const personRows = await db.execute<{
        id: number;
        display_name: string | null;
        primary_display_name: string | null;
        primary_bitbucket_uuid: string | null;
        primary_email: string | null;
        badge: UserBadge | null;
        badge_tier: UserBadgeTier | null;
      }>(sql`
        SELECT
          p.id,
          p.display_name,
          primary_user.display_name AS primary_display_name,
          primary_user.bitbucket_uuid AS primary_bitbucket_uuid,
          primary_user.email AS primary_email,
          ps.badge,
          ps.badge_tier
        FROM people p
        LEFT JOIN users primary_user
          ON primary_user.person_id = p.id
         AND primary_user.is_primary_for_person = true
        LEFT JOIN person_score ps ON ps.person_id = p.id
        WHERE p.id = ${personId}
        LIMIT 1
      `);
      const personRow = personRows.rows[0];
      if (personRow === undefined) return null;
      const person = {
        id: personRow.id,
        displayName: personRow.display_name ?? personRow.primary_display_name ?? '',
        bitbucketUuid: personRow.primary_bitbucket_uuid,
        email: personRow.primary_email,
        badge: personRow.badge,
        badgeTier: personRow.badge_tier,
      };

      // Mirrors getUserSummary's pulls, scoped to this person's alias set via
      // `author_user_id IN (...)` instead of direct equality.
      const aliasSubquery = sql`SELECT id FROM users WHERE person_id = ${personId}`;
      const [aliasRows, totalsRows, dailyRows, topRepoRows] = await Promise.all([
        db.execute<{
          id: number;
          bitbucket_uuid: string;
          display_name: string;
          username: string | null;
          email: string | null;
          is_primary: boolean;
          last_active_at: string | Date | null;
        }>(sql`
          SELECT
            u.id, u.bitbucket_uuid, u.display_name, u.username, u.email,
            u.is_primary_for_person AS is_primary,
            (SELECT max(c.authored_at) FROM commits c WHERE c.author_user_id = u.id) AS last_active_at
          FROM users u
          WHERE u.person_id = ${personId}
          ORDER BY u.is_primary_for_person DESC, u.id ASC
        `),
        db.execute<{
          commits_7d: number | null;
          commits_30d: number | null;
          commits_all_time: number | null;
          additions_7d: number | null;
          deletions_7d: number | null;
          additions_30d: number | null;
          deletions_30d: number | null;
          repositories_all_time: number | null;
        }>(sql`
          SELECT
            sum(commit_count) FILTER (WHERE day >= current_date - 6)::int AS commits_7d,
            sum(commit_count) FILTER (WHERE day >= current_date - 29)::int AS commits_30d,
            sum(commit_count)::int AS commits_all_time,
            sum(additions) FILTER (WHERE day >= current_date - 6)::int AS additions_7d,
            sum(deletions) FILTER (WHERE day >= current_date - 6)::int AS deletions_7d,
            sum(additions) FILTER (WHERE day >= current_date - 29)::int AS additions_30d,
            sum(deletions) FILTER (WHERE day >= current_date - 29)::int AS deletions_30d,
            count(DISTINCT repository_id)::int AS repositories_all_time
          FROM commit_daily
          WHERE author_user_id IN (${aliasSubquery})
        `),
        db.execute<{ date: string; commits: number }>(sql`
          SELECT day::text AS date, sum(commit_count)::int AS commits
          FROM commit_daily
          WHERE author_user_id IN (${aliasSubquery}) AND day >= current_date - 364
          GROUP BY day
          ORDER BY day
        `),
        db.execute<{
          workspace: string;
          slug: string;
          full_name: string;
          project: string | null;
          commits: number;
          last_sync_status: 'idle' | 'running' | 'success' | 'failed' | null;
          last_synced_at: string | Date | null;
          sync_excluded: boolean;
          additions_30d: number;
          deletions_30d: number;
        }>(sql`
          SELECT
            r.workspace, r.slug, r.full_name, r.project,
            sum(cd.commit_count)::int AS commits,
            ss.last_sync_status, ss.last_synced_at,
            r.sync_excluded,
            COALESCE(ds.additions_30d, 0) AS additions_30d,
            COALESCE(ds.deletions_30d, 0) AS deletions_30d
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          LEFT JOIN sync_state ss ON ss.repository_id = r.id
          LEFT JOIN (
            SELECT
              repository_id,
              sum(additions)::int AS additions_30d,
              sum(deletions)::int AS deletions_30d
            FROM commits
            WHERE author_user_id IN (${aliasSubquery})
              AND authored_at >= (current_date - 29)::timestamp
              AND NOT is_merge
            GROUP BY repository_id
          ) ds ON ds.repository_id = r.id
          WHERE cd.author_user_id IN (${aliasSubquery}) AND cd.day >= current_date - 29
          GROUP BY r.id, r.workspace, r.slug, r.full_name, r.project,
                   ss.last_sync_status, ss.last_synced_at, r.sync_excluded,
                   ds.additions_30d, ds.deletions_30d
          ORDER BY sum(cd.commit_count) DESC
          LIMIT 5
        `),
      ]);

      const t = totalsRows.rows[0];
      return {
        person,
        attachedUsers: aliasRows.rows.map((r) => ({
          id: r.id,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          username: r.username,
          email: r.email,
          isPrimary: r.is_primary,
          lastActiveAt:
            r.last_active_at === null
              ? null
              : typeof r.last_active_at === 'string'
                ? new Date(r.last_active_at).toISOString()
                : r.last_active_at.toISOString(),
        })),
        totals: {
          commits7d: t?.commits_7d ?? 0,
          commits30d: t?.commits_30d ?? 0,
          commitsAllTime: t?.commits_all_time ?? 0,
          additions7d: t?.additions_7d ?? 0,
          deletions7d: t?.deletions_7d ?? 0,
          additions30d: t?.additions_30d ?? 0,
          deletions30d: t?.deletions_30d ?? 0,
          repositoriesAllTime: t?.repositories_all_time ?? 0,
        },
        dailyCommits: dailyRows.rows.map((r) => ({ date: r.date, commits: r.commits })),
        topRepos: topRepoRows.rows.map((r) => ({
          workspace: r.workspace,
          slug: r.slug,
          fullName: r.full_name,
          project: r.project,
          commits: r.commits,
          syncStatus: deriveSyncStatus(r.last_sync_status, r.last_synced_at, r.sync_excluded),
          additions30d: r.additions_30d,
          deletions30d: r.deletions_30d,
        })),
      };
    },

    async getProjectStats(projectKey) {
      // Project existence = at least one tracked repo carrying the key; a count
      // of 0 returns null (treated as "not found" at the route layer).
      const [{ repository_count: repositoryCount } = { repository_count: 0 }] = (
        await db.execute<{ repository_count: number }>(sql`
          SELECT count(*)::int AS repository_count FROM repositories WHERE project = ${projectKey}
        `)
      ).rows;
      if (repositoryCount === 0) return null;

      const [totalsRows, dailyRows, contributorRows, repoRows] = await Promise.all([
        db.execute<{
          commits_7d: number | null;
          commits_30d: number | null;
          contributor_count_30d: number | null;
        }>(sql`
          SELECT
            sum(cd.commit_count) FILTER (WHERE cd.day >= current_date - 6)::int AS commits_7d,
            sum(cd.commit_count) FILTER (WHERE cd.day >= current_date - 29)::int AS commits_30d,
            -- Phase 5: distinct contributors over 30d, keyed per entity
            -- (merged person's aliases collapse). LEFT JOIN users keeps
            -- anonymous-author rows in the commit sums above; the count's
            -- inner CASE skips them via the author_user_id NOT NULL guard.
            count(DISTINCT CASE
              WHEN cd.day >= current_date - 29 AND cd.author_user_id IS NOT NULL
              THEN CASE WHEN u.person_id IS NULL THEN 'u:' || u.id::text ELSE 'p:' || u.person_id::text END
            END)::int AS contributor_count_30d
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          LEFT JOIN users u ON u.id = cd.author_user_id
          WHERE r.project = ${projectKey}
        `),
        // 365-day daily aggregate; same shape as user/repo dailyCommits.
        db.execute<{ date: string; commits: number }>(sql`
          SELECT cd.day::text AS date, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          WHERE r.project = ${projectKey} AND cd.day >= current_date - 364
          GROUP BY cd.day
          ORDER BY cd.day
        `),
        // Top contributors — same entity-keyed shape as getRepositoryActivity
        // (30-day sparkline + non-merge diff stats) but scoped to every repo
        // carrying this project's key.
        db.execute<{
          entity_kind: 'user' | 'person';
          entity_id: number;
          attached_user_ids: number[];
          bitbucket_uuid: string | null;
          display_name: string;
          commits: number;
          last_30_days: number[];
          additions_30d: number;
          deletions_30d: number;
        }>(sql`
          WITH project_repos AS (
            SELECT id FROM repositories WHERE project = ${projectKey}
          ),
          entity_commits AS (
            SELECT
              CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
              CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
              cd.commit_count,
              cd.day
            FROM commit_daily cd
            JOIN users u ON u.id = cd.author_user_id
            WHERE cd.repository_id IN (SELECT id FROM project_repos)
              AND cd.day >= current_date - 29
          ),
          top AS (
            SELECT entity_kind, entity_id, sum(commit_count)::int AS commits
            FROM entity_commits
            GROUP BY entity_kind, entity_id
          ),
          daily AS (
            SELECT entity_kind, entity_id, day, sum(commit_count)::int AS commits
            FROM entity_commits
            GROUP BY entity_kind, entity_id, day
          ),
          spark AS (
            SELECT
              t.entity_kind,
              t.entity_id,
              array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
            FROM top t
            CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval) AS sd(day)
            LEFT JOIN daily
              ON daily.entity_kind = t.entity_kind
             AND daily.entity_id = t.entity_id
             AND daily.day = sd.day::date
            GROUP BY t.entity_kind, t.entity_id
          ),
          diff_summary AS (
            SELECT
              CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
              CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
              sum(c.additions)::int AS additions_30d,
              sum(c.deletions)::int AS deletions_30d
            FROM commits c
            JOIN users u ON u.id = c.author_user_id
            WHERE c.repository_id IN (SELECT id FROM project_repos)
              AND c.authored_at >= (current_date - 29)::timestamp
              AND NOT c.is_merge
            GROUP BY entity_kind, entity_id
          )
          SELECT
            t.entity_kind,
            t.entity_id,
            CASE
              WHEN t.entity_kind = 'person' THEN (
                SELECT array_agg(u.id ORDER BY u.is_primary_for_person DESC, u.id)
                FROM users u
                WHERE u.person_id = t.entity_id
              )
              ELSE ARRAY[t.entity_id]
            END AS attached_user_ids,
            le.bitbucket_uuid,
            le.display_name,
            t.commits,
            spark.last_30_days,
            COALESCE(diff_summary.additions_30d, 0) AS additions_30d,
            COALESCE(diff_summary.deletions_30d, 0) AS deletions_30d
          FROM top t
          JOIN leaderboard_entries le
            ON le.entity_kind = t.entity_kind AND le.entity_id = t.entity_id
           -- Members only (membershipStatus='member'): departed ex-members and
           -- external contributors are excluded from this top-contributor
           -- ranking, matching the overview leaderboard.
           AND ${ranksAsMember}
          JOIN spark
            ON spark.entity_kind = t.entity_kind AND spark.entity_id = t.entity_id
          LEFT JOIN diff_summary
            ON diff_summary.entity_kind = t.entity_kind AND diff_summary.entity_id = t.entity_id
          ORDER BY t.commits DESC
          LIMIT 10
        `),
        // Per-repo last-commit-at comes from `commits` (the rollup doesn't
        // carry timestamps). db.execute returns timestamps as strings (the
        // query builder parses to Date), so the mapping below normalizes either.
        db.execute<{
          workspace: string;
          slug: string;
          full_name: string;
          commits_30d: number;
          contributors_30d: number;
          last_commit_at: string | Date | null;
          last_sync_status: 'idle' | 'running' | 'success' | 'failed' | null;
          last_synced_at: string | Date | null;
          sync_excluded: boolean;
          sync_exclude_reason: string | null;
        }>(sql`
          SELECT
            r.workspace,
            r.slug,
            r.full_name,
            COALESCE((
              SELECT sum(commit_count)::int FROM commit_daily
              WHERE repository_id = r.id AND day >= current_date - 29
            ), 0) AS commits_30d,
            -- Phase 5: person-aware distinct count — a merged person's
            -- aliases that both touched this repo collapse into one.
            COALESCE((
              SELECT count(DISTINCT
                CASE WHEN u.person_id IS NULL THEN 'u:' || u.id::text ELSE 'p:' || u.person_id::text END
              )::int
              FROM commit_daily cd
              JOIN users u ON u.id = cd.author_user_id
              WHERE cd.repository_id = r.id
                AND cd.day >= current_date - 29
                AND cd.author_user_id IS NOT NULL
            ), 0) AS contributors_30d,
            (SELECT max(authored_at) FROM commits WHERE repository_id = r.id) AS last_commit_at,
            ss.last_sync_status,
            ss.last_synced_at,
            r.sync_excluded,
            r.sync_exclude_reason
          FROM repositories r
          LEFT JOIN sync_state ss ON ss.repository_id = r.id
          WHERE r.project = ${projectKey}
          ORDER BY last_commit_at DESC NULLS LAST
        `),
      ]);

      const t = totalsRows.rows[0];
      return {
        project: projectKey,
        totals: {
          commits7d: t?.commits_7d ?? 0,
          commits30d: t?.commits_30d ?? 0,
          contributorCount30d: t?.contributor_count_30d ?? 0,
          repositoryCount,
        },
        dailyCommits: dailyRows.rows.map((r) => ({ date: r.date, commits: r.commits })),
        topContributors: contributorRows.rows.map((r) => ({
          entityKind: r.entity_kind,
          entityId: r.entity_id,
          attachedUserIds: r.attached_user_ids,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          commits: r.commits,
          last30Days: r.last_30_days,
          additions30d: r.additions_30d,
          deletions30d: r.deletions_30d,
        })),
        repositories: repoRows.rows.map((r) => ({
          workspace: r.workspace,
          slug: r.slug,
          fullName: r.full_name,
          commits30d: r.commits_30d,
          contributors30d: r.contributors_30d,
          lastCommitAt: r.last_commit_at === null ? null : new Date(r.last_commit_at).toISOString(),
          syncStatus: deriveSyncStatus(r.last_sync_status, r.last_synced_at, r.sync_excluded, r.sync_exclude_reason),
        })),
      };
    },

    async listTrackedRepositoriesWithStats() {
      const rows = await db.execute<{
        workspace: string;
        slug: string;
        full_name: string;
        project: string | null;
        commits_30d: number;
        contributors_30d: number;
        additions_30d: number;
        deletions_30d: number;
        last_commit_at: string | Date | null;
        last_sync_status: 'idle' | 'running' | 'success' | 'failed' | null;
        last_synced_at: string | Date | null;
        sync_excluded: boolean;
        sync_exclude_reason: string | null;
        archived: boolean;
      }>(sql`
        SELECT
          r.workspace,
          r.slug,
          r.full_name,
          r.project,
          COALESCE((
            SELECT sum(commit_count)::int FROM commit_daily
            WHERE repository_id = r.id AND day >= current_date - 29
          ), 0) AS commits_30d,
          -- Person-aware (Phase 5): a merged person's aliases that both
          -- committed to this repo collapse into one contributor. Keyed
          -- on people.id for attached aliases, users.id otherwise.
          COALESCE((
            SELECT count(DISTINCT
              CASE WHEN u.person_id IS NULL THEN 'u:' || u.id::text ELSE 'p:' || u.person_id::text END
            )::int
            FROM commit_daily cd
            JOIN users u ON u.id = cd.author_user_id
            WHERE cd.repository_id = r.id
              AND cd.day >= current_date - 29
              AND cd.author_user_id IS NOT NULL
          ), 0) AS contributors_30d,
          -- Non-merge diff stats over the last 30 days. Reads from
          -- the commits table (not commit_daily) so the merge
          -- exclusion stays accurate; the daily rollup aggregates
          -- every commit regardless of is_merge.
          COALESCE((
            SELECT sum(additions)::int FROM commits
            WHERE repository_id = r.id
              AND authored_at >= (current_date - 29)::timestamp
              AND NOT is_merge
          ), 0) AS additions_30d,
          COALESCE((
            SELECT sum(deletions)::int FROM commits
            WHERE repository_id = r.id
              AND authored_at >= (current_date - 29)::timestamp
              AND NOT is_merge
          ), 0) AS deletions_30d,
          (SELECT max(authored_at) FROM commits WHERE repository_id = r.id) AS last_commit_at,
          ss.last_sync_status,
          ss.last_synced_at,
          r.sync_excluded,
          r.sync_exclude_reason,
          r.archived
        FROM repositories r
        LEFT JOIN sync_state ss ON ss.repository_id = r.id
        ORDER BY last_commit_at DESC NULLS LAST
      `);
      return rows.rows.map((r) => ({
        workspace: r.workspace,
        slug: r.slug,
        fullName: r.full_name,
        project: r.project,
        commits30d: r.commits_30d,
        contributors30d: r.contributors_30d,
        additions30d: r.additions_30d,
        deletions30d: r.deletions_30d,
        lastCommitAt: r.last_commit_at === null ? null : new Date(r.last_commit_at).toISOString(),
        syncStatus: deriveSyncStatus(r.last_sync_status, r.last_synced_at, r.sync_excluded, r.sync_exclude_reason),
        archived: r.archived,
      }));
    },

    async getRepositoryActivity(workspace, slug) {
      const [repo] = await db
        .select({
          id: repositories.id,
          workspace: repositories.workspace,
          slug: repositories.slug,
          fullName: repositories.fullName,
          project: repositories.project,
          syncExcluded: repositories.syncExcluded,
          syncExcludeReason: repositories.syncExcludeReason,
          archived: repositories.archived,
          lastSyncStatus: syncState.lastSyncStatus,
          lastSyncedAt: syncState.lastSyncedAt,
        })
        .from(repositories)
        .leftJoin(syncState, eq(syncState.repositoryId, repositories.id))
        .where(and(eq(repositories.workspace, workspace), eq(repositories.slug, slug)))
        .limit(1);
      if (repo === undefined) return null;

      const [dailyRows, contributorRows, diffStatsRows] = await Promise.all([
        db.execute<{ date: string; commits: number; additions: number; deletions: number }>(sql`
          SELECT
            day::text AS date,
            sum(commit_count)::int AS commits,
            sum(additions)::int AS additions,
            sum(deletions)::int AS deletions
          FROM commit_daily
          WHERE repository_id = ${repo.id} AND day >= current_date - 364
          GROUP BY day
          ORDER BY day
        `),
        // Contributors for this repo with a repo-scoped 30-day sparkline each,
        // keyed on the merged ENTITY (aliases collapse into one row). Every CTE
        // is scoped to `repository_id = repo.id`, so the sparkline + adds/dels
        // reflect THIS repo only.
        db.execute<{
          entity_kind: 'user' | 'person';
          entity_id: number;
          attached_user_ids: number[];
          bitbucket_uuid: string | null;
          display_name: string;
          commits: number;
          last_30_days: number[];
          additions_30d: number;
          deletions_30d: number;
        }>(sql`
          WITH entity_commits AS (
            SELECT
              CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
              CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
              cd.commit_count,
              cd.day
            FROM commit_daily cd
            JOIN users u ON u.id = cd.author_user_id
            WHERE cd.repository_id = ${repo.id} AND cd.day >= current_date - 29
          ),
          top AS (
            SELECT entity_kind, entity_id, sum(commit_count)::int AS commits
            FROM entity_commits
            GROUP BY entity_kind, entity_id
          ),
          daily AS (
            SELECT entity_kind, entity_id, day, sum(commit_count)::int AS commits
            FROM entity_commits
            GROUP BY entity_kind, entity_id, day
          ),
          spark AS (
            SELECT
              t.entity_kind,
              t.entity_id,
              array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
            FROM top t
            CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval) AS sd(day)
            LEFT JOIN daily
              ON daily.entity_kind = t.entity_kind
             AND daily.entity_id = t.entity_id
             AND daily.day = sd.day::date
            GROUP BY t.entity_kind, t.entity_id
          ),
          diff_summary AS (
            SELECT
              CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
              CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
              sum(c.additions)::int AS additions_30d,
              sum(c.deletions)::int AS deletions_30d
            FROM commits c
            JOIN users u ON u.id = c.author_user_id
            WHERE c.repository_id = ${repo.id}
              AND c.authored_at >= (current_date - 29)::timestamp
              AND NOT c.is_merge
            GROUP BY entity_kind, entity_id
          )
          SELECT
            t.entity_kind,
            t.entity_id,
            CASE
              WHEN t.entity_kind = 'person' THEN (
                SELECT array_agg(u.id ORDER BY u.is_primary_for_person DESC, u.id)
                FROM users u
                WHERE u.person_id = t.entity_id
              )
              ELSE ARRAY[t.entity_id]
            END AS attached_user_ids,
            le.bitbucket_uuid,
            le.display_name,
            t.commits,
            spark.last_30_days,
            COALESCE(diff_summary.additions_30d, 0) AS additions_30d,
            COALESCE(diff_summary.deletions_30d, 0) AS deletions_30d
          FROM top t
          JOIN leaderboard_entries le
            ON le.entity_kind = t.entity_kind AND le.entity_id = t.entity_id
           -- Members only (membershipStatus='member'): departed ex-members and
           -- external contributors are excluded from this top-contributor
           -- ranking, matching the overview leaderboard.
           AND ${ranksAsMember}
          JOIN spark
            ON spark.entity_kind = t.entity_kind AND spark.entity_id = t.entity_id
          LEFT JOIN diff_summary
            ON diff_summary.entity_kind = t.entity_kind AND diff_summary.entity_id = t.entity_id
          ORDER BY t.commits DESC
        `),
        // Per-window code-change summary. Reads zero before diff-stats are
        // ingested (transient).
        db.execute<{
          additions_7d: number;
          deletions_7d: number;
          additions_30d: number;
          deletions_30d: number;
        }>(sql`
          SELECT
            COALESCE(SUM(CASE WHEN authored_at >= (current_date - 6)::timestamp THEN additions END), 0)::int AS additions_7d,
            COALESCE(SUM(CASE WHEN authored_at >= (current_date - 6)::timestamp THEN deletions END), 0)::int AS deletions_7d,
            COALESCE(SUM(additions), 0)::int AS additions_30d,
            COALESCE(SUM(deletions), 0)::int AS deletions_30d
          FROM commits
          WHERE repository_id = ${repo.id}
            AND authored_at >= (current_date - 29)::timestamp
            AND NOT is_merge
        `),
      ]);

      const diffStatsAgg = diffStatsRows.rows[0];
      const diffStats = {
        additions7d: diffStatsAgg?.additions_7d ?? 0,
        deletions7d: diffStatsAgg?.deletions_7d ?? 0,
        additions30d: diffStatsAgg?.additions_30d ?? 0,
        deletions30d: diffStatsAgg?.deletions_30d ?? 0,
      };
      return {
        repository: {
          workspace: repo.workspace,
          slug: repo.slug,
          fullName: repo.fullName,
          project: repo.project,
          archived: repo.archived,
          syncStatus: deriveSyncStatus(
            repo.lastSyncStatus ?? null,
            repo.lastSyncedAt ?? null,
            repo.syncExcluded,
            repo.syncExcludeReason,
          ),
        },
        dailyCommits: dailyRows.rows.map((r) => ({
          date: r.date,
          commits: r.commits,
          additions: r.additions,
          deletions: r.deletions,
        })),
        diffStats,
        contributors: contributorRows.rows.map((r) => ({
          entityKind: r.entity_kind,
          entityId: r.entity_id,
          attachedUserIds: r.attached_user_ids,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          commits: r.commits,
          last30Days: r.last_30_days,
          additions30d: r.additions_30d,
          deletions30d: r.deletions_30d,
        })),
      };
    },

    async listWorkspaceMembers() {
      // Rows keyed by (entity_kind, entity_id): aliases collapse into their
      // person, unattached users keep their own row. CTEs:
      //   entity_commits — relabel each commit_daily row with entity_kind/id.
      //   base           — per-entity 7d/30d/all-time commit + distinct-repo
      //                    counts; HAVING sum > 0 drops never-active entities.
      //   last_active    — MAX(authored_at) per entity from `commits` (the only
      //                    source with a timestamp; commit_daily has only dates).
      //   daily / spark  — 30-element per-entity sparkline.
      // Identity + scoring come from leaderboard_entries.
      //
      // Order: last_active_at DESC NULLS LAST, display_name ASC. Frontend
      // re-sorts client-side on column pick.
      const rows = await db.execute<{
        entity_kind: 'user' | 'person';
        entity_id: number;
        bitbucket_uuid: string | null;
        display_name: string;
        username: string | null;
        email: string | null;
        is_workspace_member: boolean;
        membership_status: 'member' | 'departed' | 'external';
        attached_user_ids: number[];
        alias_search: string;
        commits_7d: number;
        repos_7d: number;
        commits_30d: number;
        repos_30d: number;
        commits_all_time: number;
        repos_all_time: number;
        last_active_at: string | Date | null;
        last_30_days: number[];
        score_trending: number | null;
        consistency_90d: number | null;
        badge: UserBadge | null;
        badge_tier: UserBadgeTier | null;
        is_dormant: boolean | null;
      }>(sql`
        WITH entity_commits AS (
          SELECT
            CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
            CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
            cd.commit_count,
            cd.repository_id,
            cd.day
          FROM commit_daily cd
          JOIN users u ON u.id = cd.author_user_id
        ),
        base AS (
          SELECT
            entity_kind,
            entity_id,
            COALESCE(sum(commit_count) FILTER (WHERE day >= current_date - 6), 0)::int AS commits_7d,
            count(DISTINCT repository_id) FILTER (WHERE day >= current_date - 6)::int AS repos_7d,
            COALESCE(sum(commit_count) FILTER (WHERE day >= current_date - 29), 0)::int AS commits_30d,
            count(DISTINCT repository_id) FILTER (WHERE day >= current_date - 29)::int AS repos_30d,
            sum(commit_count)::int AS commits_all_time,
            count(DISTINCT repository_id)::int AS repos_all_time
          FROM entity_commits
          GROUP BY entity_kind, entity_id
          HAVING sum(commit_count) > 0
        ),
        last_active AS (
          SELECT
            CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
            CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
            max(c.authored_at) AS last_active_at
          FROM commits c
          JOIN users u ON u.id = c.author_user_id
          WHERE c.author_user_id IS NOT NULL
          GROUP BY entity_kind, entity_id
        ),
        daily AS (
          SELECT
            CASE WHEN u.person_id IS NULL THEN 'user'::text ELSE 'person'::text END AS entity_kind,
            CASE WHEN u.person_id IS NULL THEN u.id ELSE u.person_id END AS entity_id,
            cd.day,
            sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN users u ON u.id = cd.author_user_id
          WHERE cd.day >= current_date - 29
          GROUP BY entity_kind, entity_id, cd.day
        ),
        spark AS (
          SELECT
            b.entity_kind,
            b.entity_id,
            array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
          FROM base b
          CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval) AS sd(day)
          LEFT JOIN daily
            ON daily.entity_kind = b.entity_kind
           AND daily.entity_id = b.entity_id
           AND daily.day = sd.day::date
          GROUP BY b.entity_kind, b.entity_id
        )
        SELECT
          le.entity_kind::text AS entity_kind,
          le.entity_id,
          le.bitbucket_uuid,
          le.display_name,
          le.username,
          le.email,
          le.is_workspace_member,
          ${membershipStatusExpr} AS membership_status,
          -- attached_user_ids: primary-first ordering for stable display
          -- (the frontend's "merged from N" pill links to alias detail).
          CASE
            WHEN le.entity_kind = 'person' THEN (
              SELECT array_agg(u.id ORDER BY u.is_primary_for_person DESC, u.id)
              FROM users u
              WHERE u.person_id = le.entity_id
            )
            ELSE ARRAY[le.entity_id]
          END AS attached_user_ids,
          -- Search-only blob: every attached alias's name / username /
          -- email so a person row is findable by ANY linked account, not
          -- just the primary the row displays. The UI never renders this;
          -- it's a Fuse key on the Members table + the ActorPicker.
          CASE
            WHEN le.entity_kind = 'person' THEN COALESCE((
              SELECT string_agg(concat_ws(' ', u.display_name, u.username, u.email), ' ')
              FROM users u
              WHERE u.person_id = le.entity_id
            ), '')
            ELSE concat_ws(' ', le.display_name, le.username, le.email)
          END AS alias_search,
          b.commits_7d,
          b.repos_7d,
          b.commits_30d,
          b.repos_30d,
          b.commits_all_time,
          b.repos_all_time,
          la.last_active_at,
          s.last_30_days,
          le.score_trending,
          le.consistency_90d,
          le.badge,
          le.badge_tier,
          le.is_dormant
        FROM base b
        JOIN leaderboard_entries le
          ON le.entity_kind = b.entity_kind AND le.entity_id = b.entity_id
        LEFT JOIN last_active la
          ON la.entity_kind = b.entity_kind AND la.entity_id = b.entity_id
        JOIN spark s
          ON s.entity_kind = b.entity_kind AND s.entity_id = b.entity_id
        ORDER BY la.last_active_at DESC NULLS LAST, le.display_name ASC
      `);
      return rows.rows.map((r) => ({
        entityKind: r.entity_kind,
        entityId: r.entity_id,
        bitbucketUuid: r.bitbucket_uuid,
        displayName: r.display_name,
        username: r.username,
        email: r.email,
        isWorkspaceMember: r.is_workspace_member,
        membershipStatus: r.membership_status,
        attachedUserIds: r.attached_user_ids,
        aliasSearch: r.alias_search,
        commits7d: r.commits_7d,
        repos7d: r.repos_7d,
        commits30d: r.commits_30d,
        repos30d: r.repos_30d,
        commitsAllTime: r.commits_all_time,
        reposAllTime: r.repos_all_time,
        lastActiveAt:
          r.last_active_at === null
            ? null
            : typeof r.last_active_at === 'string'
              ? new Date(r.last_active_at).toISOString()
              : r.last_active_at.toISOString(),
        last30Days: r.last_30_days,
        scoreTrending: r.score_trending,
        consistency90d: r.consistency_90d,
        badge: r.badge,
        badgeTier: r.badge_tier,
        isDormant: r.is_dormant ?? false,
      }));
    },

    async getActivity(filters) {
      const { actor, project, before, after, hashPrefix, message, limit, offset } = filters;
      const repoFullName = filters.repo !== null ? `${filters.repo.workspace}/${filters.repo.slug}` : null;
      const beforeIso = before === null ? null : before.toISOString();
      const afterIso = after === null ? null : after.toISOString();
      // Decompose the actor into two NULL-able int params (no array literals).
      // Both NULL → actor branch is a no-op; a user matches directly; a person
      // expands to its alias set via the subquery.
      const actorUserId = actor?.kind === 'user' ? actor.id : null;
      const actorPersonId = actor?.kind === 'person' ? actor.id : null;

      // Two-branch UNION ALL with filter predicates pushed into each subquery.
      // NULL params with explicit casts let one shape cover every combination
      // of provided / omitted axes.
      //
      // Tie-break: occurred_at DESC, then `kind` (commit < pr), then per-table
      // `id` DESC. Distinct id namespaces mean no global sequence is needed —
      // pagination only needs deterministic ordering.
      const result = await db.execute<{
        kind: 'commit' | 'pr';
        id: number;
        sha: string | null;
        message: string | null;
        additions: number | null;
        deletions: number | null;
        files_changed: number | null;
        is_merge: boolean | null;
        diff_stats_unavailable: boolean | null;
        pr_id: number | null;
        title: string | null;
        state: string | null;
        source_branch: string | null;
        destination_branch: string | null;
        workspace: string;
        slug: string;
        full_name: string;
        author_user_id: number | null;
        author_display_name: string | null;
        author_bitbucket_uuid: string | null;
        occurred_at: Date | string;
      }>(sql`
        SELECT * FROM (
          SELECT
            'commit'::text AS kind,
            c.id::int AS id,
            c.sha AS sha,
            c.message AS message,
            c.additions AS additions,
            c.deletions AS deletions,
            c.files_changed AS files_changed,
            c.is_merge AS is_merge,
            -- Derive the give-up flag at query time rather than persisting a
            -- separate boolean — the threshold lives in the orchestrator
            -- (DIFF_STATS_FAILURE_THRESHOLD = 3, kept literal here so the
            -- SQL is self-contained). Stays in sync as long as both sides
            -- agree on the constant; verified by the activity-feed test.
            (c.diff_stats_failure_count >= 3) AS diff_stats_unavailable,
            NULL::int AS pr_id,
            NULL::text AS title,
            NULL::text AS state,
            NULL::text AS source_branch,
            NULL::text AS destination_branch,
            r.workspace,
            r.slug,
            r.full_name,
            u.id AS author_user_id,
            u.display_name AS author_display_name,
            u.bitbucket_uuid AS author_bitbucket_uuid,
            c.authored_at AS occurred_at
          FROM commits c
          JOIN repositories r ON r.id = c.repository_id
          LEFT JOIN users u ON u.id = c.author_user_id
          WHERE
            (
              (${actorUserId}::int IS NULL AND ${actorPersonId}::int IS NULL)
              OR c.author_user_id = ${actorUserId}::int
              OR c.author_user_id IN (SELECT u_a.id FROM users u_a WHERE u_a.person_id = ${actorPersonId}::int)
            )
            AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
            AND (${project}::text IS NULL OR r.project = ${project}::text)
            AND (${beforeIso}::timestamptz IS NULL OR c.authored_at < ${beforeIso}::timestamptz)
            AND (${afterIso}::timestamptz IS NULL OR c.authored_at >= ${afterIso}::timestamptz)
            AND (${hashPrefix}::text IS NULL OR c.sha LIKE ${hashPrefix}::text || '%')
            AND (${message}::text IS NULL OR c.message_tsv @@ plainto_tsquery('simple', ${message}::text))

          UNION ALL

          SELECT
            'pr'::text AS kind,
            pr.id::int AS id,
            NULL::text AS sha,
            NULL::text AS message,
            NULL::int AS additions,
            NULL::int AS deletions,
            NULL::int AS files_changed,
            NULL::boolean AS is_merge,
            NULL::boolean AS diff_stats_unavailable,
            pr.bitbucket_pr_id AS pr_id,
            pr.title AS title,
            pr.state::text AS state,
            pr.source_branch AS source_branch,
            pr.destination_branch AS destination_branch,
            r.workspace,
            r.slug,
            r.full_name,
            u.id AS author_user_id,
            u.display_name AS author_display_name,
            u.bitbucket_uuid AS author_bitbucket_uuid,
            pr.bitbucket_updated_at AS occurred_at
          FROM pull_requests pr
          JOIN repositories r ON r.id = pr.repository_id
          LEFT JOIN users u ON u.id = pr.author_user_id
          WHERE
            (
              (${actorUserId}::int IS NULL AND ${actorPersonId}::int IS NULL)
              OR pr.author_user_id = ${actorUserId}::int
              OR pr.author_user_id IN (SELECT u_a.id FROM users u_a WHERE u_a.person_id = ${actorPersonId}::int)
            )
            AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
            AND (${project}::text IS NULL OR r.project = ${project}::text)
            AND (${beforeIso}::timestamptz IS NULL OR pr.bitbucket_updated_at < ${beforeIso}::timestamptz)
            AND (${afterIso}::timestamptz IS NULL OR pr.bitbucket_updated_at >= ${afterIso}::timestamptz)
            -- Hash search targets commit SHAs; PRs have no SHA so the
            -- whole PR branch is suppressed when hashPrefix is set.
            AND ${hashPrefix}::text IS NULL
            AND (${message}::text IS NULL OR pr.title ILIKE '%' || ${message}::text || '%')
        ) AS feed
        ORDER BY occurred_at DESC, kind, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);

      return result.rows.map((r): ActivityEntry => {
        const repository: ActivityRepository = { workspace: r.workspace, slug: r.slug, fullName: r.full_name };
        // db.execute returns timestamps as Date or string; normalize either way.
        const occurredAt =
          typeof r.occurred_at === 'string' ? new Date(r.occurred_at).toISOString() : r.occurred_at.toISOString();
        const author: ActivityAuthor | null =
          r.author_user_id !== null
            ? {
                userId: r.author_user_id,
                displayName: r.author_display_name!,
                bitbucketUuid: r.author_bitbucket_uuid!,
              }
            : null;
        if (r.kind === 'commit') {
          return {
            kind: 'commit',
            sha: r.sha!,
            message: r.message!,
            additions: r.additions!,
            deletions: r.deletions!,
            filesChanged: r.files_changed ?? 0,
            isMerge: r.is_merge ?? false,
            diffStatsUnavailable: r.diff_stats_unavailable ?? false,
            repository,
            author,
            occurredAt,
          };
        }
        return {
          kind: 'pr',
          prId: r.pr_id!,
          title: r.title!,
          state: r.state as ActivityPullRequest['state'],
          sourceBranch: r.source_branch!,
          destinationBranch: r.destination_branch!,
          repository,
          author,
          occurredAt,
        };
      });
    },

    async getActivityCount(filters) {
      const { actor, project, before, after, hashPrefix, message } = filters;
      const repoFullName = filters.repo !== null ? `${filters.repo.workspace}/${filters.repo.slug}` : null;
      const beforeIso = before === null ? null : before.toISOString();
      const afterIso = after === null ? null : after.toISOString();
      const actorUserId = actor?.kind === 'user' ? actor.id : null;
      const actorPersonId = actor?.kind === 'person' ? actor.id : null;
      // Two-branch sum — same WHERE predicates as getActivity (incl. PR
      // suppression when hashPrefix is set) so the count never disagrees.
      const result = await db.execute<{ total: number }>(sql`
        SELECT
          (
            (SELECT count(*) FROM commits c
             JOIN repositories r ON r.id = c.repository_id
             WHERE
               (
                 (${actorUserId}::int IS NULL AND ${actorPersonId}::int IS NULL)
                 OR c.author_user_id = ${actorUserId}::int
                 OR c.author_user_id IN (SELECT u_a.id FROM users u_a WHERE u_a.person_id = ${actorPersonId}::int)
               )
               AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
               AND (${project}::text IS NULL OR r.project = ${project}::text)
               AND (${beforeIso}::timestamptz IS NULL OR c.authored_at < ${beforeIso}::timestamptz)
               AND (${afterIso}::timestamptz IS NULL OR c.authored_at >= ${afterIso}::timestamptz)
               AND (${hashPrefix}::text IS NULL OR c.sha LIKE ${hashPrefix}::text || '%')
               AND (${message}::text IS NULL OR c.message_tsv @@ plainto_tsquery('simple', ${message}::text))
            ) +
            (SELECT count(*) FROM pull_requests pr
             JOIN repositories r ON r.id = pr.repository_id
             WHERE
               (
                 (${actorUserId}::int IS NULL AND ${actorPersonId}::int IS NULL)
                 OR pr.author_user_id = ${actorUserId}::int
                 OR pr.author_user_id IN (SELECT u_a.id FROM users u_a WHERE u_a.person_id = ${actorPersonId}::int)
               )
               AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
               AND (${project}::text IS NULL OR r.project = ${project}::text)
               AND (${beforeIso}::timestamptz IS NULL OR pr.bitbucket_updated_at < ${beforeIso}::timestamptz)
               AND (${afterIso}::timestamptz IS NULL OR pr.bitbucket_updated_at >= ${afterIso}::timestamptz)
               AND ${hashPrefix}::text IS NULL
               AND (${message}::text IS NULL OR pr.title ILIKE '%' || ${message}::text || '%')
            )
          )::int AS total
      `);
      return result.rows[0]?.total ?? 0;
    },

    async getActivityDaily(filters) {
      const { actor, project } = filters;
      const repoFullName = filters.repo !== null ? `${filters.repo.workspace}/${filters.repo.slug}` : null;
      const actorUserId = actor?.kind === 'user' ? actor.id : null;
      const actorPersonId = actor?.kind === 'person' ? actor.id : null;
      // Read directly from commit_daily to keep it cheap. The repositories JOIN
      // is unconditional (needed for the repo / project filters).
      const result = await db.execute<{ date: string; commits: number }>(sql`
        SELECT cd.day::text AS date, sum(cd.commit_count)::int AS commits
        FROM commit_daily cd
        JOIN repositories r ON r.id = cd.repository_id
        WHERE cd.day >= current_date - 364
          AND (
            (${actorUserId}::int IS NULL AND ${actorPersonId}::int IS NULL)
            OR cd.author_user_id = ${actorUserId}::int
            OR cd.author_user_id IN (SELECT u_a.id FROM users u_a WHERE u_a.person_id = ${actorPersonId}::int)
          )
          AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
          AND (${project}::text IS NULL OR r.project = ${project}::text)
        GROUP BY cd.day
        ORDER BY cd.day
      `);
      return result.rows.map((r) => ({ date: r.date, commits: r.commits }));
    },

    async getRepoContributorBreakdown(opts) {
      const { windowDays, topRepos, topPerRepo, project } = opts;
      // Three-CTE pipeline: per_entity_repo (commits per repo+entity in window)
      // → top_repos (top N repos by total) → ranked (row_number per repo). The
      // final SELECT clips to top M per repo. Anonymous authors are excluded so
      // bands sum to the repo total without an "unknown" slice. A set `project`
      // restricts the seed; downstream CTEs inherit the scope via the join chain.
      const result = await db.execute<{
        workspace: string;
        slug: string;
        full_name: string;
        project: string | null;
        repo_commits: number;
        entity_kind: 'u' | 'p';
        entity_id: number;
        display_name: string;
        user_commits: number;
      }>(sql`
        WITH per_entity_repo AS (
          SELECT
            cd.repository_id,
            CASE WHEN u.person_id IS NULL THEN 'u' ELSE 'p' END AS entity_kind,
            COALESCE(u.person_id, u.id) AS entity_id,
            sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          JOIN users u ON u.id = cd.author_user_id
          WHERE cd.day >= current_date - (${windowDays - 1}::int)
            AND cd.author_user_id IS NOT NULL
            AND (${project}::text IS NULL OR r.project = ${project}::text)
          GROUP BY cd.repository_id, entity_kind, entity_id
        ),
        top_repos AS (
          SELECT repository_id, sum(commits)::int AS total_commits
          FROM per_entity_repo
          GROUP BY repository_id
          ORDER BY total_commits DESC
          LIMIT ${topRepos}
        ),
        ranked AS (
          SELECT
            per.repository_id,
            per.entity_kind,
            per.entity_id,
            per.commits,
            row_number() OVER (
              PARTITION BY per.repository_id
              ORDER BY per.commits DESC, per.entity_kind, per.entity_id
            ) AS rn
          FROM per_entity_repo per
          JOIN top_repos tr ON tr.repository_id = per.repository_id
        )
        SELECT
          r.workspace,
          r.slug,
          r.full_name,
          r.project,
          tr.total_commits AS repo_commits,
          ranked.entity_kind,
          ranked.entity_id,
          CASE
            WHEN ranked.entity_kind = 'p' THEN COALESCE(
              p.display_name,
              (
                SELECT pu.display_name FROM users pu
                WHERE pu.person_id = ranked.entity_id
                ORDER BY pu.is_primary_for_person DESC, pu.id
                LIMIT 1
              )
            )
            ELSE uu.display_name
          END AS display_name,
          ranked.commits AS user_commits
        FROM ranked
        JOIN top_repos tr ON tr.repository_id = ranked.repository_id
        JOIN repositories r ON r.id = ranked.repository_id
        LEFT JOIN people p ON ranked.entity_kind = 'p' AND p.id = ranked.entity_id
        LEFT JOIN users uu ON ranked.entity_kind = 'u' AND uu.id = ranked.entity_id
        WHERE ranked.rn <= ${topPerRepo}
        ORDER BY tr.total_commits DESC, ranked.commits DESC, ranked.entity_kind, ranked.entity_id
      `);

      // Group flat rows into repo buckets. Rows arrive repo-by-repo (top_repos
      // is the inner JOIN), so a single pass preserves the SQL ordering.
      const byRepo = new Map<string, RepoContributorBreakdown>();
      for (const row of result.rows) {
        let bucket = byRepo.get(row.full_name);
        if (bucket === undefined) {
          bucket = {
            workspace: row.workspace,
            slug: row.slug,
            fullName: row.full_name,
            project: row.project,
            commits: row.repo_commits,
            contributors: [],
          };
          byRepo.set(row.full_name, bucket);
        }
        bucket.contributors.push({
          entityKind: row.entity_kind === 'p' ? 'person' : 'user',
          entityId: row.entity_id,
          displayName: row.display_name,
          commits: row.user_commits,
        });
      }
      return Array.from(byRepo.values());
    },
  };
}

// Collapse `sync_excluded` + `last_sync_status` + `last_synced_at` to the UI
// signal. 'running' folds into 'ok'. `sync_excluded` is checked first because
// an excluded row's last_sync_status varies (404→failed, empty→success,
// history-rewrite→failed) but the exclusion is the operator-actionable signal.
function deriveSyncStatus(
  lastSyncStatus: 'idle' | 'running' | 'success' | 'failed' | null,
  lastSyncedAt: string | Date | null,
  syncExcluded: boolean = false,
  syncExcludeReason: string | null = null,
): RepoSyncStatus {
  // 'empty-on-bitbucket' is benign → 'empty'; every other reason (repo-404,
  // history-rewritten) needs an operator and stays 'excluded'.
  if (syncExcluded) return syncExcludeReason === 'empty-on-bitbucket' ? 'empty' : 'excluded';
  if (lastSyncStatus === 'failed') return 'error';
  if (lastSyncedAt === null && (lastSyncStatus === null || lastSyncStatus === 'idle')) return 'never';
  return 'ok';
}
