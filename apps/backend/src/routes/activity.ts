// Phase 4 T23 — unified activity feed at GET /api/activity. Reads commits +
// PRs as a single time-ordered stream via StatsStore.getActivity. Lives in
// its own plugin (registered at the `/api` prefix) rather than under
// statsRoutes so the URL matches the plan; the underlying store call is
// otherwise the same shape as the rest of the dashboard read endpoints.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ActivityActor, ActivityDailyFilters, ActivityFilters, StatsStore } from '../dashboard/stats-store.js';

export interface ActivityRouteOptions {
  statsStore: StatsStore;
}

// Build the actor filter from the parsed query. `actorKind` defaults to
// 'user' so the legacy `?actor=5` shape (no kind) still means "user 5" —
// stale frontend caches keep working through a rolling deploy. A person
// actor expands to its alias set inside the store SQL.
function toActor(q: { actor?: number; actorKind?: 'user' | 'person' }): ActivityActor | null {
  if (q.actor === undefined) return null;
  return { kind: q.actorKind ?? 'user', id: q.actor };
}

// Activity feed query params. All filters are optional; bare `GET /api/activity`
// returns the org-wide newest-first feed. `repo` is "<workspace>/<slug>" —
// validated by regex here so the store doesn't have to defend against
// malformed input. `before` is a strict-less-than cursor (the caller passes
// back the last entry's occurredAt to paginate); `after` is the lower bound
// (inclusive) for the dedicated Activity page's date-range filter.
// `hashPrefix` matches the canonical hex SHA — when set, the PR branch is
// suppressed (PRs don't carry a SHA). `message` runs Postgres FTS on commits
// (`message_tsv`) and a cheap ILIKE on PR titles.
const activityQuerySchema = z.object({
  actor: z.coerce.number().int().positive().optional(),
  // Phase 5: discriminates whether `actor` is a users.id or a people.id.
  // Defaults to 'user' in toActor() so omitting it preserves the legacy
  // single-user behavior.
  actorKind: z.enum(['user', 'person']).optional(),
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'must be "<workspace>/<slug>"')
    .optional(),
  project: z.string().min(1).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  after: z.string().datetime({ offset: true }).optional(),
  hashPrefix: z
    .string()
    .regex(/^[0-9a-f]{1,40}$/i, 'must be 1–40 hex characters')
    .optional(),
  message: z.string().min(2).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Offset-based pagination for the dedicated /activity page (First /
  // Last / jump-to-page). Default 0 keeps the cursor-only embedded feed
  // untouched. Capped at 100k so a runaway client can't cause a deep
  // sequential scan; realistic workspaces stay well below this.
  offset: z.coerce.number().int().nonnegative().max(100_000).default(0),
});

// Subset of the feed filters that meaningfully apply to a 365-day daily
// aggregate. Date range / hash / message are intentionally absent — the
// year heatmap answers "what does the last year look like for this
// slice?" regardless of the page's date window or text search.
const activityDailyQuerySchema = z.object({
  actor: z.coerce.number().int().positive().optional(),
  actorKind: z.enum(['user', 'person']).optional(),
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'must be "<workspace>/<slug>"')
    .optional(),
  project: z.string().min(1).optional(),
});

export const activityRoutes: FastifyPluginAsync<ActivityRouteOptions> = async (app, opts) => {
  app.get<{ Querystring: Record<string, string | undefined> }>('/activity', async (request, reply) => {
    const parsed = activityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    let repo: ActivityFilters['repo'] = null;
    if (q.repo !== undefined) {
      const [workspace, slug] = q.repo.split('/') as [string, string];
      repo = { workspace, slug };
    }
    const filters: ActivityFilters = {
      actor: toActor(q),
      repo,
      project: q.project ?? null,
      before: q.before !== undefined ? new Date(q.before) : null,
      after: q.after !== undefined ? new Date(q.after) : null,
      hashPrefix: q.hashPrefix !== undefined ? q.hashPrefix.toLowerCase() : null,
      message: q.message ?? null,
      limit: q.limit,
      offset: q.offset,
    };
    return opts.statsStore.getActivity(filters);
  });

  // Count of entries matching the same filter shape — used by the
  // Activity page to render "Page X of Y" and enable the Last button.
  // Shares the schema with /activity so callers can echo the query
  // string verbatim; `limit` / `offset` are accepted but ignored.
  app.get<{ Querystring: Record<string, string | undefined> }>('/activity-count', async (request, reply) => {
    const parsed = activityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    let repo: ActivityFilters['repo'] = null;
    if (q.repo !== undefined) {
      const [workspace, slug] = q.repo.split('/') as [string, string];
      repo = { workspace, slug };
    }
    const filters: ActivityFilters = {
      actor: toActor(q),
      repo,
      project: q.project ?? null,
      before: q.before !== undefined ? new Date(q.before) : null,
      after: q.after !== undefined ? new Date(q.after) : null,
      hashPrefix: q.hashPrefix !== undefined ? q.hashPrefix.toLowerCase() : null,
      message: q.message ?? null,
      limit: q.limit,
      offset: q.offset,
    };
    const total = await opts.statsStore.getActivityCount(filters);
    return { total };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/activity-daily', async (request, reply) => {
    const parsed = activityDailyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    let repo: ActivityDailyFilters['repo'] = null;
    if (q.repo !== undefined) {
      const [workspace, slug] = q.repo.split('/') as [string, string];
      repo = { workspace, slug };
    }
    const filters: ActivityDailyFilters = {
      actor: toActor(q),
      repo,
      project: q.project ?? null,
    };
    return opts.statsStore.getActivityDaily(filters);
  });
};
