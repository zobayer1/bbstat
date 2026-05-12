// Dashboard read-side store. Same pattern as DiscoveryStore — interface +
// Drizzle impl — to keep route tests pure (fake store, no DB) and to keep
// the Phase 3 rollups + Redis cache pluggable behind the same interface.
//
// All commit-aggregation methods now read from `commit_daily` (per-day per
// repo per author rollup). The aggregation reads use UTC day buckets — the
// pre-rollup implementation used rolling time windows down to the millisecond,
// but day buckets are what the dashboard reasonably means by "last 7 days"
// and match what the rollup table can give us cheaply at any size. Methods
// that need per-commit detail (`getLatestCommitForRepository`,
// `getRepositoryActivity.recentCommits`) still hit `commits` directly — the
// rollup doesn't carry shas, messages, or precise timestamps.

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commits, repositories, users } from '../db/schema.js';

export interface OverviewStats {
  users: number;
  repositories: number;
  projects: number;
  totalCommits: number;
  commitsLast7Days: number;
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

export interface UserSummary {
  user: { id: number; bitbucketUuid: string; displayName: string };
  totals: {
    commits7d: number;
    commits30d: number;
    commitsAllTime: number;
    additions7d: number;
    deletions7d: number;
    additions30d: number;
    deletions30d: number;
  };
  // Last 30 calendar days, oldest first. Days with zero commits are omitted —
  // the frontend backfills the gaps to render a continuous sparkline.
  dailyCommits: Array<{ date: string; commits: number }>;
  // Top 5 repos this user committed to in the last 30 days.
  topRepos: Array<{ workspace: string; slug: string; fullName: string; commits: number }>;
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
  topContributors: TopContributor[];
  repositories: Array<{
    workspace: string;
    slug: string;
    fullName: string;
    commits30d: number;
    lastCommitAt: string | null;
  }>;
}

export interface RepoActivity {
  repository: { workspace: string; slug: string; fullName: string };
  // Last 30 calendar days, oldest first. Zero-commit days omitted.
  dailyCommits: Array<{ date: string; commits: number; additions: number; deletions: number }>;
  // Last 20 commits across all authors (anonymous included).
  recentCommits: LatestCommit[];
  // All contributors active in the last 30 days, ordered by commit count desc.
  contributors: TopContributor[];
}

export interface TrackedRepositorySummary {
  workspace: string;
  slug: string;
  fullName: string;
  // Project key as stored on repositories.project (null for unassigned repos).
  project: string | null;
  commits30d: number;
  lastCommitAt: string | null;
}

export interface StatsStore {
  getOverview(): Promise<OverviewStats>;
  // Returns null when the repo isn't tracked or has no commits ingested yet.
  // Doesn't distinguish the two — the dashboard treats them the same ("—").
  getLatestCommitForRepository(workspace: string, slug: string): Promise<LatestCommit | null>;
  // Top N developers by commit count over the trailing window. Anonymous /
  // unmatched-author commits are excluded — they have no user to attribute.
  getTopContributors(windowDays: number, limit?: number): Promise<TopContributor[]>;

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
        db.execute<{ commits_last_7_days: number }>(sql`
          SELECT COALESCE(sum(commit_count), 0)::int AS commits_last_7_days
          FROM commit_daily WHERE day >= current_date - 6
        `),
      ]);
      return {
        users: usersRows[0]?.count ?? 0,
        repositories: reposRows[0]?.count ?? 0,
        projects: projectsRows[0]?.count ?? 0,
        totalCommits: totalCommitsRows.rows[0]?.total_commits ?? 0,
        commitsLast7Days: recentCommitsRows.rows[0]?.commits_last_7_days ?? 0,
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
      const rows = await db.execute<{
        user_id: number;
        bitbucket_uuid: string;
        display_name: string;
        commits: number;
      }>(sql`
        SELECT u.id AS user_id, u.bitbucket_uuid, u.display_name, sum(cd.commit_count)::int AS commits
        FROM commit_daily cd
        JOIN users u ON u.id = cd.author_user_id
        WHERE cd.day >= current_date - ${windowDays - 1}::int
        GROUP BY u.id, u.bitbucket_uuid, u.display_name
        ORDER BY sum(cd.commit_count) DESC
        LIMIT ${limit}
      `);
      return rows.rows.map((r) => ({
        userId: r.user_id,
        bitbucketUuid: r.bitbucket_uuid,
        displayName: r.display_name,
        commits: r.commits,
      }));
    },

    async getUserSummary(userId) {
      const [user] = await db
        .select({
          id: users.id,
          bitbucketUuid: users.bitbucketUuid,
          displayName: users.displayName,
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
        }>(sql`
          SELECT
            sum(commit_count) FILTER (WHERE day >= current_date - 6)::int AS commits_7d,
            sum(commit_count) FILTER (WHERE day >= current_date - 29)::int AS commits_30d,
            sum(commit_count)::int AS commits_all_time,
            sum(additions) FILTER (WHERE day >= current_date - 6)::int AS additions_7d,
            sum(deletions) FILTER (WHERE day >= current_date - 6)::int AS deletions_7d,
            sum(additions) FILTER (WHERE day >= current_date - 29)::int AS additions_30d,
            sum(deletions) FILTER (WHERE day >= current_date - 29)::int AS deletions_30d
          FROM commit_daily
          WHERE author_user_id = ${userId}
        `),
        db.execute<{ date: string; commits: number }>(sql`
          SELECT day::text AS date, sum(commit_count)::int AS commits
          FROM commit_daily
          WHERE author_user_id = ${userId} AND day >= current_date - 29
          GROUP BY day
          ORDER BY day
        `),
        db.execute<{ workspace: string; slug: string; full_name: string; commits: number }>(sql`
          SELECT r.workspace, r.slug, r.full_name, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN repositories r ON r.id = cd.repository_id
          WHERE cd.author_user_id = ${userId} AND cd.day >= current_date - 29
          GROUP BY r.id, r.workspace, r.slug, r.full_name
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
        },
        dailyCommits: dailyRows.rows.map((r) => ({ date: r.date, commits: r.commits })),
        topRepos: topRepoRows.rows.map((r) => ({
          workspace: r.workspace,
          slug: r.slug,
          fullName: r.full_name,
          commits: r.commits,
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

      const [totalsRows, weeklyRows, contributorRows, repoRows] = await Promise.all([
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
          last_commit_at: string | Date | null;
        }>(sql`
          SELECT
            r.workspace,
            r.slug,
            r.full_name,
            COALESCE((
              SELECT sum(commit_count)::int FROM commit_daily
              WHERE repository_id = r.id AND day >= current_date - 29
            ), 0) AS commits_30d,
            (SELECT max(authored_at) FROM commits WHERE repository_id = r.id) AS last_commit_at
          FROM repositories r
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
          lastCommitAt: r.last_commit_at === null ? null : new Date(r.last_commit_at).toISOString(),
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
        last_commit_at: string | Date | null;
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
          (SELECT max(authored_at) FROM commits WHERE repository_id = r.id) AS last_commit_at
        FROM repositories r
        ORDER BY last_commit_at DESC NULLS LAST
      `);
      return rows.rows.map((r) => ({
        workspace: r.workspace,
        slug: r.slug,
        fullName: r.full_name,
        project: r.project,
        commits30d: r.commits_30d,
        lastCommitAt: r.last_commit_at === null ? null : new Date(r.last_commit_at).toISOString(),
      }));
    },

    async getRepositoryActivity(workspace, slug) {
      const [repo] = await db
        .select({
          id: repositories.id,
          workspace: repositories.workspace,
          slug: repositories.slug,
          fullName: repositories.fullName,
        })
        .from(repositories)
        .where(and(eq(repositories.workspace, workspace), eq(repositories.slug, slug)))
        .limit(1);
      if (repo === undefined) return null;

      const [dailyRows, recentRows, contributorRows] = await Promise.all([
        db.execute<{ date: string; commits: number; additions: number; deletions: number }>(sql`
          SELECT
            day::text AS date,
            sum(commit_count)::int AS commits,
            sum(additions)::int AS additions,
            sum(deletions)::int AS deletions
          FROM commit_daily
          WHERE repository_id = ${repo.id} AND day >= current_date - 29
          GROUP BY day
          ORDER BY day
        `),
        db
          .select({
            sha: commits.sha,
            message: commits.message,
            authoredAt: commits.authoredAt,
            authorDisplayName: users.displayName,
            authorBitbucketUuid: users.bitbucketUuid,
          })
          .from(commits)
          .leftJoin(users, eq(commits.authorUserId, users.id))
          .where(eq(commits.repositoryId, repo.id))
          .orderBy(desc(commits.authoredAt))
          .limit(20),
        db.execute<{ user_id: number; bitbucket_uuid: string; display_name: string; commits: number }>(sql`
          SELECT u.id AS user_id, u.bitbucket_uuid, u.display_name, sum(cd.commit_count)::int AS commits
          FROM commit_daily cd
          JOIN users u ON u.id = cd.author_user_id
          WHERE cd.repository_id = ${repo.id} AND cd.day >= current_date - 29
          GROUP BY u.id, u.bitbucket_uuid, u.display_name
          ORDER BY sum(cd.commit_count) DESC
        `),
      ]);

      return {
        repository: { workspace: repo.workspace, slug: repo.slug, fullName: repo.fullName },
        dailyCommits: dailyRows.rows.map((r) => ({
          date: r.date,
          commits: r.commits,
          additions: r.additions,
          deletions: r.deletions,
        })),
        recentCommits: recentRows.map((r) => ({
          sha: r.sha,
          message: r.message,
          authoredAt: r.authoredAt.toISOString(),
          authorDisplayName: r.authorDisplayName,
          authorBitbucketUuid: r.authorBitbucketUuid,
        })),
        contributors: contributorRows.rows.map((r) => ({
          userId: r.user_id,
          bitbucketUuid: r.bitbucket_uuid,
          displayName: r.display_name,
          commits: r.commits,
        })),
      };
    },
  };
}
