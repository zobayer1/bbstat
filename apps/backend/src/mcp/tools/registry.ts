// The read-only MCP tool registry. The server (commit 3) iterates this array
// and registers each entry with the SDK. Adding a tool = append it here.
//
// Ordering is roughly "broad → specific" so a model scanning the list sees
// the orienting tools (overview, leaderboard, directories) before the
// drill-in / query tools.

import { activityDailyTool, searchActivityTool } from './activity.js';
import { contributorSummaryTool, listMembersTool, topContributorsTool } from './contributors.js';
import { getOverviewTool } from './overview.js';
import { projectStatsTool } from './projects.js';
import { listRepositoriesTool, repositoryActivityTool } from './repositories.js';
import type { AnyToolDef } from './types.js';

export const tools: AnyToolDef[] = [
  getOverviewTool,
  topContributorsTool,
  listMembersTool,
  contributorSummaryTool,
  listRepositoriesTool,
  repositoryActivityTool,
  projectStatsTool,
  searchActivityTool,
  activityDailyTool,
];
