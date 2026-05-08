// Dashboard read-side store. Same pattern as DiscoveryStore — interface +
// Drizzle impl — to keep route tests pure (fake store, no DB) and to leave
// room for the Phase 3 rollups / Redis-backed user-summary cache to plug in
// behind the same interface without changing route code.

import { isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { repositories, users } from '../db/schema.js';

export interface OverviewStats {
  users: number;
  repositories: number;
  projects: number;
}

export interface StatsStore {
  getOverview(): Promise<OverviewStats>;
}

export function createDrizzleStatsStore(db: Database): StatsStore {
  return {
    async getOverview() {
      const [usersRow] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
      const [reposRow] = await db.select({ count: sql<number>`count(*)::int` }).from(repositories);
      const [projectsRow] = await db
        .select({ count: sql<number>`count(distinct project)::int` })
        .from(repositories)
        .where(isNotNull(repositories.project));
      return {
        users: usersRow?.count ?? 0,
        repositories: reposRow?.count ?? 0,
        projects: projectsRow?.count ?? 0,
      };
    },
  };
}
