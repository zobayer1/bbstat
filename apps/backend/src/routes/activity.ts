// Unified activity feed at GET /api/activity — commits + PRs as a single
// time-ordered stream via StatsStore.getActivity.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ActivityActor, ActivityDailyFilters, ActivityFilters, StatsStore } from '../dashboard/stats-store.js';

export interface ActivityRouteOptions {
  statsStore: StatsStore;
}

// `actorKind` defaults to 'user' so the legacy `?actor=5` shape (no kind)
// still means "user 5" — stale frontend caches keep working through a rolling
// deploy. A person actor expands to its alias set inside the store SQL.
function toActor(q: { actor?: number; actorKind?: 'user' | 'person' }): ActivityActor | null {
  if (q.actor === undefined) return null;
  return { kind: q.actorKind ?? 'user', id: q.actor };
}

// All filters optional; bare GET /api/activity returns the org-wide
// newest-first feed. `before` is a strict-less-than cursor; `after` is the
// inclusive lower bound for the date-range filter. `hashPrefix` set suppresses
// PR rows (PRs carry no SHA). `message` runs Postgres FTS on commits
// (`message_tsv`) and a cheap ILIKE on PR titles.
const activityQuerySchema = z.object({
  actor: z.coerce.number().int().positive().optional(),
  // Discriminates whether `actor` is a users.id or a people.id.
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
  // Offset pagination for the /activity page. Capped at 100k so a runaway
  // client can't trigger a deep sequential scan.
  offset: z.coerce.number().int().nonnegative().max(100_000).default(0),
});

// Subset of feed filters that apply to a 365-day daily aggregate. Date range
// / hash / message are intentionally absent — the heatmap always answers "what
// does the last year look like for this slice?".
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

  // Count of entries matching the same filter shape — drives "Page X of Y".
  // Shares the schema with /activity; `limit` / `offset` are ignored here.
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
