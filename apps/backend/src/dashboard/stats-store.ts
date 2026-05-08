// Dashboard read-side store. Same pattern as DiscoveryStore — interface +
// Drizzle impl — to keep route tests pure (fake store, no DB) and to leave
// room for the Phase 3 rollups / Redis-backed user-summary cache to plug in
// behind the same interface without changing route code.
//
// Phase 2 queries hit `commits` directly. They're fine at curated-set scale
// (~50 active repos, tens of thousands of commits) but Phase 3 will swap in
// pre-aggregated rollup tables behind this interface to keep latency flat as
// the table grows.

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
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

export interface StatsStore {
  getOverview(): Promise<OverviewStats>;
  // Returns null when the repo isn't tracked or has no commits ingested yet.
  // Doesn't distinguish the two — the dashboard treats them the same ("—").
  getLatestCommitForRepository(workspace: string, slug: string): Promise<LatestCommit | null>;
  // Top N developers by commit count over the trailing window. Anonymous /
  // unmatched-author commits are excluded — they have no user to attribute.
  getTopContributors(windowDays: number, limit?: number): Promise<TopContributor[]>;
}

export function createDrizzleStatsStore(db: Database): StatsStore {
  return {
    async getOverview() {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
      const [usersRow] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      const [reposRow] = await db.select({ count: sql<number>`count(*)::int` }).from(repositories);
      const [projectsRow] = await db
        .select({ count: sql<number>`count(distinct project)::int` })
        .from(repositories)
        .where(isNotNull(repositories.project));
      const [totalCommitsRow] = await db.select({ count: sql<number>`count(*)::int` }).from(commits);
      const [recentCommitsRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(commits)
        .where(gte(commits.authoredAt, sevenDaysAgo));
      return {
        users: usersRow?.count ?? 0,
        repositories: reposRow?.count ?? 0,
        projects: projectsRow?.count ?? 0,
        totalCommits: totalCommitsRow?.count ?? 0,
        commitsLast7Days: recentCommitsRow?.count ?? 0,
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
      const cutoff = new Date(Date.now() - windowDays * 86_400_000);
      return await db
        .select({
          userId: users.id,
          bitbucketUuid: users.bitbucketUuid,
          displayName: users.displayName,
          commits: sql<number>`count(${commits.id})::int`,
        })
        .from(commits)
        .innerJoin(users, eq(commits.authorUserId, users.id))
        .where(gte(commits.authoredAt, cutoff))
        .groupBy(users.id, users.bitbucketUuid, users.displayName)
        .orderBy(desc(sql`count(${commits.id})`))
        .limit(limit);
    },
  };
}
