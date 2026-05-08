import pino from 'pino';
import type { Logger } from 'pino';

// Single pino factory used by both the API server (apps/backend/src/index.ts)
// and the sync runner (apps/backend/src/sync/index.ts), and passed into
// Fastify so app.log is the same instance.
export function createLogger(nodeEnv: string): Logger {
  if (nodeEnv === 'test') return pino({ level: 'silent' });
  if (nodeEnv === 'development') {
    return pino({
      level: 'debug',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino({ level: 'info' });
}
