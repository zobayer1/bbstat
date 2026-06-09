import { z } from 'zod';
import { defineTool, ToolError } from './types.js';

// Leaderboard over a trailing window. Each row carries entityKind + entityId,
// which is exactly what get_contributor_summary needs — so this doubles as a
// resolver from "who's active" to a drillable id.
export const topContributorsTool = defineTool({
  name: 'top_contributors',
  title: 'Top contributors',
  description:
    'Top developers by commit count over a trailing window (default 30 days). Each row includes entity_kind + entity_id, a display name, commit/line totals, repo breadth, and momentum/consistency scores. Use the entity_kind + entity_id from a row to fetch full detail with get_contributor_summary. Anonymous / unattributed commits are excluded.',
  inputShape: {
    window_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe('Trailing window in days. The dashboard uses 7, 30, or 90.'),
    limit: z.number().int().min(1).max(100).default(10).describe('Max rows to return.'),
  },
  async handler(store, args) {
    return store.getTopContributors(args.window_days, args.limit);
  },
});

// The directory. Resolve a name / email a human mentions into the
// entity_kind + entity_id that the detail tools key on.
export const listMembersTool = defineTool({
  name: 'list_members',
  title: 'List members',
  description:
    'The workspace member directory — one row per contributor with entity_kind, entity_id, display name, username, email, workspace-membership flag, and 7d/30d commit counts. This is the lookup table: when a human names a person or gives an email, find their row here to get the entity_kind + entity_id, then call get_contributor_summary. Returns everyone with at least one ingested commit. Takes no arguments.',
  inputShape: {},
  async handler(store) {
    return store.listWorkspaceMembers();
  },
});

// Full per-contributor detail. Dispatches on entity_kind: 'user' (a single
// unmerged BitBucket account) vs 'person' (a merged identity aggregating
// several aliases). Ids are NOT interchangeable across kinds.
export const contributorSummaryTool = defineTool({
  name: 'get_contributor_summary',
  title: 'Contributor summary',
  description:
    "Full activity detail for one contributor: commit totals across windows, lines added/removed, per-repo breakdown, badges, and score. Requires both entity_kind and entity_id — get them from list_members or top_contributors (do not guess ids). entity_kind 'user' is a single BitBucket account; 'person' is a merged identity spanning several aliases. Errors if no such entity exists.",
  inputShape: {
    entity_kind: z.enum(['user', 'person']).describe("'user' for an unmerged account, 'person' for a merged identity."),
    entity_id: z.number().int().positive().describe('The entity_id from list_members / top_contributors.'),
  },
  async handler(store, args) {
    const summary =
      args.entity_kind === 'person'
        ? await store.getPersonSummary(args.entity_id)
        : await store.getUserSummary(args.entity_id);
    if (summary === null) {
      throw new ToolError(
        `No ${args.entity_kind} found with id ${args.entity_id}. Resolve ids via list_members or top_contributors.`,
      );
    }
    return summary;
  },
});
