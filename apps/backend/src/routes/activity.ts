// Phase 4 T23 — unified activity feed at GET /api/activity. Reads commits +
// PRs as a single time-ordered stream via StatsStore.getActivity. Lives in
// its own plugin (registered at the `/api` prefix) rather than under
// statsRoutes so the URL matches the plan; the underlying store call is
// otherwise the same shape as the rest of the dashboard read endpoints.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ActivityFilters, StatsStore } from '../dashboard/stats-store.js';

export interface ActivityRouteOptions {
  statsStore: StatsStore;
}

// Activity feed query params. All filters are optional; bare `GET /api/activity`
// returns the org-wide newest-first feed. `repo` is "<workspace>/<slug>" —
// validated by regex here so the store doesn't have to defend against
// malformed input. `before` is a strict-less-than cursor (the caller passes
// back the last entry's occurredAt to paginate).
const activityQuerySchema = z.object({
  actor: z.coerce.number().int().positive().optional(),
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'must be "<workspace>/<slug>"')
    .optional(),
  project: z.string().min(1).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
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
      actor: q.actor ?? null,
      repo,
      project: q.project ?? null,
      before: q.before !== undefined ? new Date(q.before) : null,
      limit: q.limit,
    };
    return opts.statsStore.getActivity(filters);
  });
};
