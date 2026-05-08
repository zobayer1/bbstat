import type { FastifyServerOptions } from 'fastify';

export function loggerOptions(nodeEnv: string): FastifyServerOptions['logger'] {
  if (nodeEnv === 'test') return false;
  if (nodeEnv === 'development') {
    return {
      level: 'debug',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: 'info' };
}
