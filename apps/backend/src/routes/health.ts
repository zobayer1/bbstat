import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));
  app.get('/readyz', async () => ({ status: 'ready' }));
};
