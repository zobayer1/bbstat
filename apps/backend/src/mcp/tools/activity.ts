import { z } from 'zod';
import type { ActivityDailyFilters, ActivityFilters } from '../../dashboard/stats-store.js';
import { defineTool } from './types.js';

// Shared sub-shapes. `actor` keys on entity_kind + entity_id (resolve via
// list_members / top_contributors); `repo` on workspace + slug (resolve via
// list_repositories).
const actorShape = z
  .object({
    kind: z.enum(['user', 'person']),
    id: z.number().int().positive(),
  })
  .describe('Filter to one contributor. id is the entity_id; kind matches it.');

const repoShape = z
  .object({
    workspace: z.string().min(1),
    slug: z.string().min(1),
  })
  .describe('Filter to one repository.');

// The AND-combinable filter set shared by search_activity and count_activity.
// (limit is search-only — count is over the full filtered universe.)
const activityFilterShape = {
  actor: actorShape.optional(),
  repo: repoShape.optional(),
  project: z.string().min(1).optional().describe('Project key.'),
  after: z.coerce.date().optional().describe('Only entries at/after this instant (ISO 8601).'),
  before: z.coerce.date().optional().describe('Only entries strictly before this instant (ISO 8601).'),
  message: z.string().min(1).optional().describe('Free-text search over commit messages / PR titles.'),
  hash_prefix: z
    .string()
    .regex(/^[0-9a-fA-F]{1,40}$/)
    .optional()
    .describe('Commit SHA prefix (hex, 1–40 chars). Suppresses PRs, which carry no SHA.'),
};

type ActivityFilterArgs = z.infer<z.ZodObject<typeof activityFilterShape>>;

// Map validated filter args + a limit into the store's ActivityFilters shape.
// MCP is a stateless read surface — no cursor pagination, so offset is always 0.
function buildFilters(args: ActivityFilterArgs, limit: number): ActivityFilters {
  return {
    actor: args.actor ? { kind: args.actor.kind, id: args.actor.id } : null,
    repo: args.repo ?? null,
    project: args.project ?? null,
    before: args.before ?? null,
    after: args.after ?? null,
    hashPrefix: args.hash_prefix ? args.hash_prefix.toLowerCase() : null,
    message: args.message ?? null,
    limit,
    offset: 0,
  };
}

// The unified commit + PR feed with AND-combinable filters. This is the
// flexible query surface — most "what happened with X" questions route here.
export const searchActivityTool = defineTool({
  name: 'search_activity',
  title: 'Search activity',
  description:
    'Unified, filterable feed of commits and pull requests, newest first. All filters are optional and AND-combined: actor (a contributor), repo, project, a date range (after / before, ISO 8601), a free-text message search, and a commit-SHA prefix. Resolve actor ids via list_members/top_contributors and repos via list_repositories. Returns up to `limit` entries (default 50, max 200). For the total count of a filter set (not capped) use count_activity; for a time series use activity_daily.',
  inputShape: {
    ...activityFilterShape,
    limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return.'),
  },
  async handler(store, args) {
    return store.getActivity(buildFilters(args, args.limit));
  },
});

// Exact total for a filter set — over the FULL universe, not capped by a limit
// like search_activity. The tool for "how many …" questions.
export const countActivityTool = defineTool({
  name: 'count_activity',
  title: 'Count activity',
  description:
    'Total number of activity entries (commits + PRs) matching a filter set — counted over the FULL filtered universe, not capped like search_activity (which stops at its limit). Same filters as search_activity (actor / repo / project / date range / message / hash_prefix), minus limit. Use this for "how many …" questions; use search_activity to list the entries themselves.',
  inputShape: activityFilterShape,
  async handler(store, args) {
    // limit is ignored by getActivityCount; pass 0.
    const count = await store.getActivityCount(buildFilters(args, 0));
    return { count };
  },
});

// Daily commit counts for the trailing year — the heatmap data, useful for
// "how consistent has X been" without pulling every entry.
export const activityDailyTool = defineTool({
  name: 'activity_daily',
  title: 'Daily activity series',
  description:
    'Daily commit counts over the trailing ~365 days as { date, commits } points (days with zero commits are omitted). Optionally narrowed by actor, repo, or project. Good for trend / consistency questions. Note: only actor/repo/project narrow this — date range and text search are intentionally ignored (it always answers "what does the last year look like for this slice?").',
  inputShape: {
    actor: actorShape.optional(),
    repo: repoShape.optional(),
    project: z.string().min(1).optional().describe('Project key.'),
  },
  async handler(store, args) {
    const filters: ActivityDailyFilters = {
      actor: args.actor ? { kind: args.actor.kind, id: args.actor.id } : null,
      repo: args.repo ?? null,
      project: args.project ?? null,
    };
    return store.getActivityDaily(filters);
  },
});
