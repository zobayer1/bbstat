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

// The unified commit + PR feed with AND-combinable filters. This is the
// flexible query surface — most "what happened with X" questions route here.
export const searchActivityTool = defineTool({
  name: 'search_activity',
  title: 'Search activity',
  description:
    'Unified, filterable feed of commits and pull requests, newest first. All filters are optional and AND-combined: actor (a contributor), repo, project, a date range (after / before, ISO 8601), a free-text message search, and a commit-SHA prefix. Resolve actor ids via list_members/top_contributors and repos via list_repositories. Returns up to `limit` entries (default 50, max 200). For a time-series count instead of individual entries, use activity_daily.',
  inputShape: {
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
    limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return.'),
  },
  async handler(store, args) {
    const filters: ActivityFilters = {
      actor: args.actor ? { kind: args.actor.kind, id: args.actor.id } : null,
      repo: args.repo ?? null,
      project: args.project ?? null,
      before: args.before ?? null,
      after: args.after ?? null,
      hashPrefix: args.hash_prefix ? args.hash_prefix.toLowerCase() : null,
      message: args.message ?? null,
      limit: args.limit,
      // MCP is a stateless read surface — no cursor pagination, just the
      // first `limit` newest entries for the filter set.
      offset: 0,
    };
    return store.getActivity(filters);
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
