// Dashboard read-side store. Same pattern as DiscoveryStore — interface +
// Drizzle impl — to keep route tests pure (fake store, no DB) and to keep
// the Phase 3 rollups + Redis cache pluggable behind the same interface.
//
// All commit-aggregation methods now read from `commit_daily` (per-day per
// repo per author rollup). The aggregation reads use UTC day buckets — the
// pre-rollup implementation used rolling time windows down to the millisecond,
// but day buckets are what the dashboard reasonably means by "last 7 days"
// and match what the rollup table can give us cheaply at any size. The only
// method still reading per-commit detail from `commits` is
// `getLatestCommitForRepository`; the unified activity feed reads commits +
// PRs via the dedicated `getActivity` query.

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commits, repositories, syncState, users } from '../db/schema.js';

export interface OverviewStats {
  users: number;
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

export interface TopContributor {
  userId: number;
  bitbucketUuid: string;
  displayName: string;
  commits: number;
}

// Phase 4 T24 — TopContributor enriched with a 30-day commit sparkline.
// Used only on the org-wide `getTopContributors` leaderboard so the
// Dashboard's Top Contributors panel can render a per-user trend line.
// Project / repo contributor lists deliberately stay on the base shape;
// adding sparklines to those would require parallel CTEs without giving
// the dashboard any new information.
export interface TopContributorWithSparkline extends TopContributor {
  // Length 30, oldest-first, zeros for days with no commits.
  last30Days: number[];
}

export interface UserSummary {
  user: { id: number; bitbucketUuid: string; displayName: string; email: string | null };
  totals: {
    commits7d: number;
    commits30d: number;
    commitsAllTime: number;
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
    // Distinct repositories this user has ever landed a commit in (across
    // the full history we've ingested — bounded by deepen-backfill
    // progress). Pairs with `commitsAllTime` on the user detail page.
    repositoriesAllTime: number;
  };
  // Last 365 calendar days, oldest first. Days with zero commits are omitted —
  // the frontend backfills gaps when rendering (e.g. the contribution
  // heatmap on the user detail page).
  dailyCommits: Array<{ date: string; commits: number }>;
  // Top 5 repos this user committed to in the last 30 days.
  topRepos: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    project: string | null;
    commits: number;
    syncStatus: RepoSyncStatus;
    // This user's last-30-day per-repo code-change footprint, excluding
    // merge commits. Zero when diff-stats haven't landed yet for any
    // commits in this window (rare in steady state — the backfill
    // tick chases freshness first) or when the user genuinely made
    // no non-merge changes here. File count is intentionally NOT
    // aggregated — SUM(files_changed) across many commits
    // double-counts paths edited repeatedly. Per-commit file count
    // still appears in the activity feed.
    additions30d: number;
    deletions30d: number;
  }>;
}

export interface ProjectStats {
  project: string;
  totals: {
    commits7d: number;
    commits30d: number;
    contributorCount7d: number;
    repositoryCount: number;
  };
  // Last 12 ISO weeks (Monday-aligned per Postgres date_trunc), oldest first.
  weeklyCommits: Array<{ weekStart: string; commits: number }>;
  // Last 365 calendar days, oldest first. Zero-commit days omitted —
  // the frontend backfills gaps when rendering the contribution heatmap.
  // Aggregates across every repo carrying this project's key.
  dailyCommits: Array<{ date: string; commits: number }>;
  topContributors: TopContributor[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
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
    syncStatus: RepoSyncStatus;
  };
  // Last 365 calendar days, oldest first. Zero-commit days omitted —
  // the frontend backfills gaps when rendering the contribution heatmap.
  dailyCommits: Array<{ date: string; commits: number; additions: number; deletions: number }>;
  // Per-window code-change summary, excluding merge commits. Day
  // windows match the commit cards: 7d = last 7 calendar days, 30d =
  // last 30. Always returned (no longer gated on a per-repo opt-in
  // flag); reads zero when no diff-stat ingest has landed yet, which
  // is a transient state the backfill tick chases by freshness-first
  // global pickup.
  diffStats: {
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
  };
  // All contributors active in the last 30 days, ordered by commit count desc.
  // `last30Days` is repo-scoped (this user's commits in THIS repo, day-by-day)
  // so the repo-detail sparkline reflects the contributor's activity here,
  // not their workspace-wide pattern. Diff-stat fields are 30-day,
  // exclude merges, read zero when no diff-stat ingest has landed
  // yet for this repo (transient — the backfill tick will fill in).
  contributors: RepoContributor[];
}

export interface RepoContributor extends TopContributorWithSparkline {
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
  // Distinct file paths touched by the commit (= rows in BB's /diffstat
  // response). 0 when diff-stats haven't been fetched yet for the
  // commit (diff_stats_synced_at IS NULL) — same as additions/deletions
  // in that case. Rendered alongside the +X/−Y line counts in the
  // activity feed for context.
  filesChanged: number;
  // True when the underlying commit has more than one parent. Surfaced
  // here so the dashboard can flag merges (their additions/deletions
  // include the entire merged-branch delta and shouldn't be read as
  // authorship volume). Future per-user 30d aggregates over adds/dels
  // will default-exclude rows where `is_merge = true`.
  isMerge: boolean;
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

export interface ActivityFilters {
  // All filters are AND-combinable; null means "no filter on this axis".
  actor: number | null;
  repo: { workspace: string; slug: string } | null;
  project: string | null;
  // Cursor — only entries with occurredAt strictly less than this. Null on
  // the first page; subsequent pages pass the last entry's occurredAt back.
  before: Date | null;
  // Default 50, max 200 — enforced at the route layer.
  limit: number;
}

// Derived sync health for a tracked repository, surfaced to the dashboard
// as a small status icon. Maps `repositories.sync_excluded` +
// `sync_state.last_sync_status`:
//   - sync_excluded=true                                  → 'excluded' (red — auto-tripped, needs attention)
//   - last_sync_status='failed'                           → 'error'   (amber — transient / actionable failure)
//   - last_sync_status='success'/'running' + last_synced_at set → 'ok' (green)
//   - last_sync_status='idle' + null timestamp            → 'never'   (slate — not synced yet)
// Kept as a closed-set string (not the raw enum) so the frontend doesn't
// need to know about 'running' as a separate state — a mid-flight tick is
// considered healthy here. `excluded` outranks `error` because the
// underlying cause is durable (rename / empty / force-push) and the
// recovery is a specific admin action, not a wait-and-retry.
export type RepoSyncStatus = 'ok' | 'error' | 'never' | 'excluded';

// One row per workspace member with at least one ingested commit. Powers
// the standalone /members page (Members.vue). Anonymous / unmatched-author
// commits are excluded — they have no user to attribute and the page is a
// roster, not a commit log. Window-zero rows still appear (a quiet week
// shouldn't empty the list); never-committed users are filtered out at the
// SQL level.
export interface WorkspaceMember {
  userId: number;
  bitbucketUuid: string;
  displayName: string;
  username: string | null;
  // Git-author email captured from commits.author.raw at ingest time,
  // write-once. NOT a verified workspace email — see the comment on
  // users.email in schema.ts for caveats. Null when no commit for this
  // user has yet landed a parseable address (or the user predates the
  // column on a not-yet-resynced deployment).
  email: string | null;
  // Per-window aggregates. Additions / deletions read from commit_daily
  // and so carry the same merge semantics as getUserSummary's totals — the
  // dashboard treats them the same way.
  commitsWindow: number;
  commitsAllTime: number;
  additionsWindow: number;
  deletionsWindow: number;
  // Distinct repos this member committed to in the active window vs ever.
  reposWindow: number;
  reposAllTime: number;
  // MAX(commits.authored_at) across all this member's commits. Null is
  // theoretically unreachable (the filter requires commitsAllTime > 0) but
  // typed to match the underlying source.
  lastActiveAt: string | null;
  // Length 30, oldest-first, zeros for days with no commits. Same shape as
  // TopContributorWithSparkline.last30Days so the Sparkline component
  // renders unchanged.
  last30Days: number[];
}

export interface TrackedRepositorySummary {
  workspace: string;
  slug: string;
  fullName: string;
  // Project key as stored on repositories.project (null for unassigned repos).
  project: string | null;
  commits30d: number;
  // Distinct non-null author_user_id values active in the last 30 days.
  // Anonymous / unmatched-author commits don't count toward this — the
  // dashboard column reflects "developers who landed code", not raw author
  // identities.
  contributors30d: number;
  lastCommitAt: string | null;
  syncStatus: RepoSyncStatus;
}

export interface StatsStore {
  getOverview(): Promise<OverviewStats>;
  // Returns null when the repo isn't tracked or has no commits ingested yet.
  // Doesn't distinguish the two — the dashboard treats them the same ("—").
  getLatestCommitForRepository(workspace: string, slug: string): Promise<LatestCommit | null>;
  // Top N developers by commit count over the trailing window. Anonymous /
  // unmatched-author commits are excluded — they have no user to attribute.
  // Each row also carries a 30-day commit-count series for the Dashboard
  // sparkline rendering.
  getTopContributors(windowDays: number, limit?: number): Promise<TopContributorWithSparkline[]>;

  // Returns null when the user id doesn't exist. An existing user with no
  // commits returns a populated summary with all-zero totals and empty arrays.
  getUserSummary(userId: number): Promise<UserSummary | null>;
  // Returns null when no repositories carry the given project key. An empty
  // project (no commits across its repos) returns zero totals and empty arrays.
  getProjectStats(projectKey: string): Promise<ProjectStats | null>;
  // Returns null when the repo isn't tracked. A tracked repo with no commits
  // returns empty arrays.
  getRepositoryActivity(workspace: string, slug: string): Promise<RepoActivity | null>;
  // Dashboard list endpoint. All tracked repositories, ordered by most-recent
  // activity. The dashboard renders this directly as the Repositories panel
  // and groups by `project` client-side to drive the Projects panel.
  listTrackedRepositoriesWithStats(): Promise<TrackedRepositorySummary[]>;
  // Workspace member roster for the /members page. One row per user with at
  // least one ingested commit (commitsAllTime > 0) — window-zero rows still
  // appear so a quiet week doesn't empty the page. Anonymous / unmatched-
  // author commits are excluded. Ordered server-side by commitsWindow DESC,
  // displayName ASC so the default render lands "most-active first" without
  // a client sort. Pagination + fuzzy-search run on the frontend over this
  // list (org-scale dataset, full payload fits in one round-trip).
  listWorkspaceMembers(windowDays: number): Promise<WorkspaceMember[]>;

  // Phase 4 T23 — unified activity feed. UNION ALL of commits + PRs with
  // per-branch filter predicates, ordered by `occurredAt DESC` then by
  // `kind, id DESC` so ties break deterministically (otherwise pagination
  // can skip / duplicate). Read directly from Postgres — list endpoints
  // bypass Redis per CLAUDE.md's "Redis is user-summary only" rule.
  getActivity(filters: ActivityFilters): Promise<ActivityEntry[]>;
}

export function createDrizzleStatsStore(db: Database): StatsStore {
  return {
    async getOverview() {
      // users / repositories / projects are base-table counts and aren't
      // related to the rollup. totalCommits and commitsLast7Days now read
      // from commit_daily so this endpoint stays cheap regardless of how
      // large `commits` grows.
      const [usersRows, reposRows, projectsRows, totalCommitsRows, recentCommitsRows] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(users),
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
        users: usersRows[0]?.count ?? 0,
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
      // INNER JOIN to users naturally excludes anonymous-author rows
      // (cd.author_user_id IS NULL won't match any users row), matching the
      // pre-rollup behavior. Window is `windowDays` UTC day buckets ending
      // today: e.g. windowDays=7 → day >= current_date - 6 covers 7 days.
      //
      // The ::int cast on the bound param is load-bearing: without it
      // Postgres can't infer the type of `current_date - $1` and falls back
      // to the `date - date` overload (which yields integer), then the
      // outer comparison `day >= integer` fails to resolve.
      //
      // Phase 4 T24: the same query also derives a 30-day sparkline per
      // contributor in one pass. The `top` CTE picks the leaderboard;
      // `spark` cross-joins it with a 30-day generate_series window and
      // LEFT JOINs the same commit_daily aggregated by user+day so missing
      // days become zero. The result is array_agg'd in date order so the
      // frontend can render the SVG line directly without backfilling.
      const rows = await db.execute<{
        user_id: number;
        bitbucket_uuid: string;
        display_name: string;
        commits: number;
        last_30_days: number[];
      }>(sql`
        WITH top AS (
          SELECT u.id AS user_id, u.bitbucket_uuid, u.display_name, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN users u ON u.id = cd.author_user_id
          WHERE cd.day >= current_date - ${windowDays - 1}::int
          GROUP BY u.id, u.bitbucket_uuid, u.display_name
          ORDER BY sum(cd.commit_count) DESC
          LIMIT ${limit}
        ),
        daily AS (
          SELECT author_user_id, day, sum(commit_count)::int AS commits
          FROM commit_daily
          WHERE day >= current_date - 29
            AND author_user_id IN (SELECT user_id FROM top)
          GROUP BY author_user_id, day
        ),
        spark AS (
          SELECT
            t.user_id,
            array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
          FROM top t
          CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval)
            AS sd(day)
          LEFT JOIN daily ON daily.author_user_id = t.user_id AND daily.day = sd.day::date
          GROUP BY t.user_id
        )
        SELECT t.user_id, t.bitbucket_uuid, t.display_name, t.commits, spark.last_30_days
        FROM top t
        JOIN spark ON spark.user_id = t.user_id
        ORDER BY t.commits DESC
      `);
      return rows.rows.map((r) => ({
        userId: r.user_id,
        bitbucketUuid: r.bitbucket_uuid,
        displayName: r.display_name,
        commits: r.commits,
        last30Days: r.last_30_days,
      }));
    },

    async getUserSummary(userId) {
      const [user] = await db
        .select({
          id: users.id,
          bitbucketUuid: users.bitbucketUuid,
          displayName: users.displayName,
          email: users.email,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (user === undefined) return null;

      // Run aggregates in parallel — independent queries against commit_daily.
      const [totalsRows, dailyRows, topRepoRows] = await Promise.all([
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
      ]);

      const t = totalsRows.rows[0];
      return {
        user,
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
      // Project existence is determined by at least one tracked repo carrying
      // the key. Empty project key strings would return zero results but we
      // still treat them as "not found" up at the route layer via the missing
      // result here.
      const [{ repository_count: repositoryCount } = { repository_count: 0 }] = (
        await db.execute<{ repository_count: number }>(sql`
          SELECT count(*)::int AS repository_count FROM repositories WHERE project = ${projectKey}
        `)
      ).rows;
      if (repositoryCount === 0) return null;

      const [totalsRows, weeklyRows, dailyRows, contributorRows, repoRows] = await Promise.all([
        db.execute<{
          commits_7d: number | null;
          commits_30d: number | null;
          contributor_count_7d: number | null;
        }>(sql`
          SELECT
            sum(cd.commit_count) FILTER (WHERE cd.day >= current_date - 6)::int AS commits_7d,
            sum(cd.commit_count) FILTER (WHERE cd.day >= current_date - 29)::int AS commits_30d,
            count(DISTINCT cd.author_user_id)
              FILTER (WHERE cd.day >= current_date - 6 AND cd.author_user_id IS NOT NULL)::int
              AS contributor_count_7d
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          WHERE r.project = ${projectKey}
        `),
        // 12 weeks back, Monday-aligned. Filtering on the original `day`
        // column (and not on `week_start`) keeps the predicate sargable
        // against the (repo, day) index.
        db.execute<{ week_start: string; commits: number }>(sql`
          SELECT date_trunc('week', cd.day)::date::text AS week_start, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          WHERE r.project = ${projectKey}
            AND cd.day >= date_trunc('week', current_date)::date - (11 * 7)
          GROUP BY week_start
          ORDER BY week_start
        `),
        // 365-day daily aggregate. Mirrors the user/repo dailyCommits shape
        // so the CommitHeatmap component can render the project's combined
        // contribution timeline without any client-side reshaping.
        db.execute<{ date: string; commits: number }>(sql`
          SELECT cd.day::text AS date, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          WHERE r.project = ${projectKey} AND cd.day >= current_date - 364
          GROUP BY cd.day
          ORDER BY cd.day
        `),
        db.execute<{ user_id: number; bitbucket_uuid: string; display_name: string; commits: number }>(sql`
          SELECT u.id AS user_id, u.bitbucket_uuid, u.display_name, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          JOIN users u ON u.id = cd.author_user_id
          WHERE r.project = ${projectKey} AND cd.day >= current_date - 29
          GROUP BY u.id, u.bitbucket_uuid, u.display_name
          ORDER BY sum(cd.commit_count) DESC
          LIMIT 10
        `),
        // Per-repo last-commit-at comes from `commits` (the rollup doesn't
        // carry timestamps). Cheap subquery — bounded by repo count per
        // project. `db.execute` returns timestamps as strings (unlike the
        // Drizzle query builder which parses to Date), so we accept either
        // and normalize via `new Date(...).toISOString()` below.
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
        }>(sql`
          SELECT
            r.workspace,
            r.slug,
            r.full_name,
            COALESCE((
              SELECT sum(commit_count)::int FROM commit_daily
              WHERE repository_id = r.id AND day >= current_date - 29
            ), 0) AS commits_30d,
            COALESCE((
              SELECT count(DISTINCT author_user_id)::int FROM commit_daily
              WHERE repository_id = r.id
                AND day >= current_date - 29
                AND author_user_id IS NOT NULL
            ), 0) AS contributors_30d,
            (SELECT max(authored_at) FROM commits WHERE repository_id = r.id) AS last_commit_at,
            ss.last_sync_status,
            ss.last_synced_at,
            r.sync_excluded
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
          contributorCount7d: t?.contributor_count_7d ?? 0,
          repositoryCount,
        },
        weeklyCommits: weeklyRows.rows.map((r) => ({ weekStart: r.week_start, commits: r.commits })),
        dailyCommits: dailyRows.rows.map((r) => ({ date: r.date, commits: r.commits })),
        topContributors: contributorRows.rows.map((r) => ({
          userId: r.user_id,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          commits: r.commits,
        })),
        repositories: repoRows.rows.map((r) => ({
          workspace: r.workspace,
          slug: r.slug,
          fullName: r.full_name,
          commits30d: r.commits_30d,
          contributors30d: r.contributors_30d,
          lastCommitAt: r.last_commit_at === null ? null : new Date(r.last_commit_at).toISOString(),
          syncStatus: deriveSyncStatus(r.last_sync_status, r.last_synced_at, r.sync_excluded),
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
        last_commit_at: string | Date | null;
        last_sync_status: 'idle' | 'running' | 'success' | 'failed' | null;
        last_synced_at: string | Date | null;
        sync_excluded: boolean;
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
          COALESCE((
            SELECT count(DISTINCT author_user_id)::int FROM commit_daily
            WHERE repository_id = r.id
              AND day >= current_date - 29
              AND author_user_id IS NOT NULL
          ), 0) AS contributors_30d,
          (SELECT max(authored_at) FROM commits WHERE repository_id = r.id) AS last_commit_at,
          ss.last_sync_status,
          ss.last_synced_at,
          r.sync_excluded
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
        lastCommitAt: r.last_commit_at === null ? null : new Date(r.last_commit_at).toISOString(),
        syncStatus: deriveSyncStatus(r.last_sync_status, r.last_synced_at, r.sync_excluded),
      }));
    },

    async getRepositoryActivity(workspace, slug) {
      const [repo] = await db
        .select({
          id: repositories.id,
          workspace: repositories.workspace,
          slug: repositories.slug,
          fullName: repositories.fullName,
          syncExcluded: repositories.syncExcluded,
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
        // Top contributors for this repo plus a repo-scoped 30-day sparkline
        // per contributor. Same shape as `getTopContributors` (Phase 4 T24)
        // but the `daily` CTE is constrained to `repository_id = repo.id`, so
        // each user's sparkline only reflects activity in this repo.
        db.execute<{
          user_id: number;
          bitbucket_uuid: string;
          display_name: string;
          commits: number;
          last_30_days: number[];
          additions_30d: number;
          deletions_30d: number;
        }>(sql`
          WITH top AS (
            SELECT u.id AS user_id, u.bitbucket_uuid, u.display_name, sum(cd.commit_count)::int AS commits
            FROM commit_daily cd
            JOIN users u ON u.id = cd.author_user_id
            WHERE cd.repository_id = ${repo.id} AND cd.day >= current_date - 29
            GROUP BY u.id, u.bitbucket_uuid, u.display_name
          ),
          daily AS (
            SELECT author_user_id, day, sum(commit_count)::int AS commits
            FROM commit_daily
            WHERE repository_id = ${repo.id}
              AND day >= current_date - 29
              AND author_user_id IN (SELECT user_id FROM top)
            GROUP BY author_user_id, day
          ),
          spark AS (
            SELECT
              t.user_id,
              array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
            FROM top t
            CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval) AS sd(day)
            LEFT JOIN daily ON daily.author_user_id = t.user_id AND daily.day = sd.day::date
            GROUP BY t.user_id
          ),
          diff_summary AS (
            SELECT
              author_user_id,
              sum(additions)::int AS additions_30d,
              sum(deletions)::int AS deletions_30d
            FROM commits
            WHERE repository_id = ${repo.id}
              AND authored_at >= (current_date - 29)::timestamp
              AND NOT is_merge
              AND author_user_id IN (SELECT user_id FROM top)
            GROUP BY author_user_id
          )
          SELECT
            t.user_id,
            t.bitbucket_uuid,
            t.display_name,
            t.commits,
            spark.last_30_days,
            COALESCE(diff_summary.additions_30d, 0) AS additions_30d,
            COALESCE(diff_summary.deletions_30d, 0) AS deletions_30d
          FROM top t
          JOIN spark ON spark.user_id = t.user_id
          LEFT JOIN diff_summary ON diff_summary.author_user_id = t.user_id
          ORDER BY t.commits DESC
        `),
        // Per-window code-change summary for the repo. Always returned —
        // the per-repo opt-in flag was removed in 2026-05; every
        // non-archived non-excluded repo participates in diff-stat
        // ingest by default. Reads zero on rows whose diff-stats
        // haven't been ingested yet (transient state).
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
          syncStatus: deriveSyncStatus(repo.lastSyncStatus ?? null, repo.lastSyncedAt ?? null, repo.syncExcluded),
        },
        dailyCommits: dailyRows.rows.map((r) => ({
          date: r.date,
          commits: r.commits,
          additions: r.additions,
          deletions: r.deletions,
        })),
        diffStats,
        contributors: contributorRows.rows.map((r) => ({
          userId: r.user_id,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          commits: r.commits,
          last30Days: r.last_30_days,
          additions30d: r.additions_30d,
          deletions30d: r.deletions_30d,
        })),
      };
    },

    async listWorkspaceMembers(windowDays) {
      // Single round-trip, four CTEs:
      //   base        — per-user aggregates from commit_daily, filtered to
      //                 users who've ever landed a commit (commits_all_time > 0
      //                 via the GROUP BY HAVING). Window-zero rows still pass.
      //   last_active — MAX(authored_at) per user from `commits` (not
      //                 commit_daily, which has no timestamp — only day).
      //   daily       — last-30-day per-(user, day) commit counts, restricted
      //                 to the eligible user set so the cross-join below is
      //                 bounded by member count, not by user-id space.
      //   spark       — array_agg into a 30-element commit sparkline per user,
      //                 oldest-first, zeros for missing days. Same shape as
      //                 TopContributorWithSparkline.last30Days so the
      //                 frontend's Sparkline component renders unchanged.
      //
      // Window is windowDays UTC day buckets ending today — e.g. windowDays=7
      // → day >= current_date - 6 covers 7 days. The ::int cast on the bound
      // param is load-bearing (see getTopContributors for the same note —
      // without it, current_date - $1 falls back to the date-date overload).
      //
      // Order: commits_window DESC, display_name ASC. The frontend resorts
      // client-side when the user picks a different sort column.
      const rows = await db.execute<{
        user_id: number;
        bitbucket_uuid: string;
        display_name: string;
        username: string | null;
        email: string | null;
        commits_window: number;
        commits_all_time: number;
        additions_window: number;
        deletions_window: number;
        repos_window: number;
        repos_all_time: number;
        last_active_at: string | Date | null;
        last_30_days: number[];
      }>(sql`
        WITH base AS (
          SELECT
            cd.author_user_id AS user_id,
            COALESCE(sum(cd.commit_count) FILTER (WHERE cd.day >= current_date - ${windowDays - 1}::int), 0)::int
              AS commits_window,
            sum(cd.commit_count)::int AS commits_all_time,
            COALESCE(sum(cd.additions) FILTER (WHERE cd.day >= current_date - ${windowDays - 1}::int), 0)::int
              AS additions_window,
            COALESCE(sum(cd.deletions) FILTER (WHERE cd.day >= current_date - ${windowDays - 1}::int), 0)::int
              AS deletions_window,
            count(DISTINCT cd.repository_id)
              FILTER (WHERE cd.day >= current_date - ${windowDays - 1}::int)::int
              AS repos_window,
            count(DISTINCT cd.repository_id)::int AS repos_all_time
          FROM commit_daily cd
          WHERE cd.author_user_id IS NOT NULL
          GROUP BY cd.author_user_id
          HAVING sum(cd.commit_count) > 0
        ),
        last_active AS (
          SELECT c.author_user_id AS user_id, max(c.authored_at) AS last_active_at
          FROM commits c
          WHERE c.author_user_id IN (SELECT user_id FROM base)
          GROUP BY c.author_user_id
        ),
        daily AS (
          SELECT cd.author_user_id, cd.day, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          WHERE cd.day >= current_date - 29
            AND cd.author_user_id IN (SELECT user_id FROM base)
          GROUP BY cd.author_user_id, cd.day
        ),
        spark AS (
          SELECT
            b.user_id,
            array_agg(COALESCE(daily.commits, 0) ORDER BY sd.day) AS last_30_days
          FROM base b
          CROSS JOIN generate_series(current_date - 29, current_date, '1 day'::interval) AS sd(day)
          LEFT JOIN daily ON daily.author_user_id = b.user_id AND daily.day = sd.day::date
          GROUP BY b.user_id
        )
        SELECT
          u.id AS user_id,
          u.bitbucket_uuid,
          u.display_name,
          u.username,
          u.email,
          b.commits_window,
          b.commits_all_time,
          b.additions_window,
          b.deletions_window,
          b.repos_window,
          b.repos_all_time,
          la.last_active_at,
          s.last_30_days
        FROM base b
        JOIN users u ON u.id = b.user_id
        LEFT JOIN last_active la ON la.user_id = b.user_id
        JOIN spark s ON s.user_id = b.user_id
        ORDER BY b.commits_window DESC, u.display_name ASC
      `);
      return rows.rows.map((r) => ({
        userId: r.user_id,
        bitbucketUuid: r.bitbucket_uuid,
        displayName: r.display_name,
        username: r.username,
        email: r.email,
        commitsWindow: r.commits_window,
        commitsAllTime: r.commits_all_time,
        additionsWindow: r.additions_window,
        deletionsWindow: r.deletions_window,
        reposWindow: r.repos_window,
        reposAllTime: r.repos_all_time,
        lastActiveAt:
          r.last_active_at === null
            ? null
            : typeof r.last_active_at === 'string'
              ? new Date(r.last_active_at).toISOString()
              : r.last_active_at.toISOString(),
        last30Days: r.last_30_days,
      }));
    },

    async getActivity(filters) {
      const { actor, project, before, limit } = filters;
      const repoFullName = filters.repo !== null ? `${filters.repo.workspace}/${filters.repo.slug}` : null;
      const beforeIso = before === null ? null : before.toISOString();

      // Two-branch UNION ALL with filter predicates pushed into each subquery
      // (we don't want to pull rows that the outer ORDER BY + LIMIT will
      // discard). NULL params with explicit casts let one filter shape cover
      // every combination of provided / omitted axes.
      //
      // Tie-break order: occurred_at DESC, then `kind` (commit < pr lexically)
      // then per-table `id` DESC. Distinct id namespaces between branches
      // means we don't need a global sequence — pagination just needs the
      // ordering to be deterministic, which it is.
      const result = await db.execute<{
        kind: 'commit' | 'pr';
        id: number;
        sha: string | null;
        message: string | null;
        additions: number | null;
        deletions: number | null;
        files_changed: number | null;
        is_merge: boolean | null;
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
            (${actor}::int IS NULL OR c.author_user_id = ${actor}::int)
            AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
            AND (${project}::text IS NULL OR r.project = ${project}::text)
            AND (${beforeIso}::timestamptz IS NULL OR c.authored_at < ${beforeIso}::timestamptz)

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
            (${actor}::int IS NULL OR pr.author_user_id = ${actor}::int)
            AND (${repoFullName}::text IS NULL OR r.full_name = ${repoFullName}::text)
            AND (${project}::text IS NULL OR r.project = ${project}::text)
            AND (${beforeIso}::timestamptz IS NULL OR pr.bitbucket_updated_at < ${beforeIso}::timestamptz)
        ) AS feed
        ORDER BY occurred_at DESC, kind, id DESC
        LIMIT ${limit}
      `);

      return result.rows.map((r): ActivityEntry => {
        const repository: ActivityRepository = { workspace: r.workspace, slug: r.slug, fullName: r.full_name };
        // db.execute returns timestamps as either Date (when Drizzle parses)
        // or string (raw pg driver). Normalize either way.
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
  };
}

// Collapse `sync_excluded` + `last_sync_status` + `last_synced_at` to
// the 4-state UI signal. A 'running' status is folded into 'ok' — the
// current tick is in flight, the previous outcome is what matters.
// `sync_excluded` is checked first; an excluded row's last_sync_status
// might be anything (commits 404 sets 'failed', empty-on-bb leaves it
// 'success', history-rewritten sets 'failed') but the exclusion is
// the operator-actionable signal.
function deriveSyncStatus(
  lastSyncStatus: 'idle' | 'running' | 'success' | 'failed' | null,
  lastSyncedAt: string | Date | null,
  syncExcluded: boolean = false,
): RepoSyncStatus {
  if (syncExcluded) return 'excluded';
  if (lastSyncStatus === 'failed') return 'error';
  if (lastSyncedAt === null && (lastSyncStatus === null || lastSyncStatus === 'idle')) return 'never';
  return 'ok';
}
