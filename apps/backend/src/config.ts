import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_HOST: z.string().default('bbstat.localhost'),
  BACKEND_PORT: z.coerce.number().int().positive().default(8443),
  TLS_KEY_PATH: z.string().default('etc/tls/server.key'),
  TLS_CERT_PATH: z.string().default('etc/tls/server.crt'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  BITBUCKET_BASE_URL: z.string().url().default('https://api.bitbucket.org/2.0'),
  BITBUCKET_WORKSPACE: z.string().optional(),
  BITBUCKET_AUTH_EMAIL: z.string().optional(),
  BITBUCKET_AUTH_TOKEN: z.string().optional(),

  // Comma-separated `<workspace>/<slug>` pairs to bootstrap the curated
  // tracked-repository set on startup. Empty = no auto-bootstrap; admins add
  // repos via POST /api/admin/repositories instead.
  SEED_TRACKED_REPOS: z.string().default(''),

  // Cron schedules for the discovery sync. Defaults are tight to make crons
  // easy to observe during dev; lengthen them in production once we trust
  // the runner (e.g., '0 */6 * * *' for repos, '0 0 * * *' for members).
  SYNC_MEMBERS_CRON: z.string().default('*/10 * * * *'),
  SYNC_REPOS_CRON: z.string().default('*/5 * * * *'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
