// The read-only MCP tool registry; the server iterates this array. Ordering is
// roughly "broad → specific" so a model scanning the list sees orienting tools
// (overview, leaderboard, directories) before the drill-in / query tools.

import { activityDailyTool, countActivityTool, searchActivityTool } from './activity.js';
import { contributorSummaryTool, listMembersTool, topContributorsTool } from './contributors.js';
import { getOverviewTool } from './overview.js';
import { projectStatsTool } from './projects.js';
import { listRepositoriesTool, repoContributorBreakdownTool, repositoryActivityTool } from './repositories.js';
import type { AnyToolDef } from './types.js';

export const tools: AnyToolDef[] = [
  getOverviewTool,
  topContributorsTool,
  listMembersTool,
  contributorSummaryTool,
  listRepositoriesTool,
  repositoryActivityTool,
  repoContributorBreakdownTool,
  projectStatsTool,
  searchActivityTool,
  countActivityTool,
  activityDailyTool,
];
