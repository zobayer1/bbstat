import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { registerRoutes } from './routes/index.js';
import { loggerOptions } from './lib/logger.js';
import type { AppConfig } from './config.js';

export interface BuildAppOptions {
  config: AppConfig;
  https?: { key: Buffer; cert: Buffer };
}

export async function buildApp({ config, https }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config.NODE_ENV),
    ...(https ? { https } : {}),
  });

  await app.register(sensible);
  await app.register(cors, {
    // No auth today: allow the dev frontend origin and same-origin requests.
    origin: true,
    credentials: false,
  });
  await app.register(registerRoutes);

  return app;
}
