import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { StatsStore } from '../dashboard/stats-store.js';

export interface StatsRouteOptions {
  statsStore: StatsStore;
}

const windowSchema = z.enum(['7d', '30d']).default('7d');

export const statsRoutes: FastifyPluginAsync<StatsRouteOptions> = async (app, opts) => {
  app.get('/overview', async () => {
    return opts.statsStore.getOverview();
  });

  app.get<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/latest-commit',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const commit = await opts.statsStore.getLatestCommitForRepository(workspace, slug);
      if (commit === null) return reply.code(404).send({ error: 'not_found', fullName: `${workspace}/${slug}` });
      return commit;
    },
  );

  app.get<{ Querystring: { window?: string } }>('/top-contributors', async (request, reply) => {
    const parsed = windowSchema.safeParse(request.query.window ?? '7d');
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_window', allowed: ['7d', '30d'] });
    }
    const days = parsed.data === '7d' ? 7 : 30;
    return opts.statsStore.getTopContributors(days);
  });
};
