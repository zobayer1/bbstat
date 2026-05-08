import type { FastifyPluginAsync } from 'fastify';
import type { StatsStore } from '../dashboard/stats-store.js';

export interface StatsRouteOptions {
  statsStore: StatsStore;
}

export const statsRoutes: FastifyPluginAsync<StatsRouteOptions> = async (app, opts) => {
  app.get('/overview', async () => {
    return opts.statsStore.getOverview();
  });
};
