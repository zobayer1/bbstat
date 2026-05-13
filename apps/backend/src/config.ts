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
  // Soft cap on outbound BitBucket calls per rolling hour, enforced inside
  // BitbucketClient. BB Cloud's documented per-identity limit is ~1000/hr;
  // 800 leaves a safety margin. See memory/bitbucket_rate_limit_headers.md.
  BITBUCKET_HOURLY_CALL_BUDGET: z.coerce.number().int().positive().default(800),

  // Path to the curated tracked-repository seed file (YAML). Resolved against
  // the repo root if relative. If unset, defaults to `tracked-repos.yaml` at
  // the repo root — and a missing default file is a no-op (admins add repos
  // via POST /api/admin/repositories instead). If explicitly set, the file
  // must exist or startup fails loud.
  SEED_REPO_FILE_PATH: z.string().optional(),

  // Cron schedules. Defaults are tight to make crons easy to observe during
  // dev; lengthen them in production once we trust the runner.
  SYNC_MEMBERS_CRON: z.string().default('*/10 * * * *'),
  SYNC_REPOS_CRON: z.string().default('*/5 * * * *'),
  SYNC_COMMITS_CRON: z.string().default('*/15 * * * *'),

  // First-run cap on commit backfill per repo: stop after N pages of 100, or
  // at any commit older than COMMITS_BACKFILL_SINCE (whichever fires first).
  // Empty SINCE = no date cap. No effect on delta runs (those always stop at
  // last_seen_sha).
  COMMITS_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  COMMITS_BACKFILL_SINCE: z
    .string()
    .default('')
    .refine((s) => s === '' || !Number.isNaN(Date.parse(s)), {
      message: 'COMMITS_BACKFILL_SINCE must be an ISO 8601 date string or empty',
    }),

  // Tick orchestration. Concurrency = max repos in flight; threshold = budget
  // headroom under BITBUCKET_HOURLY_CALL_BUDGET below which we stop scheduling
  // new repos (deferred to the next tick).
  COMMIT_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  COMMIT_SYNC_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Phase 4 T21: per-repo diff-stat ingest (1 BB call per new commit, opt-in
  // via tracked-repos.yaml). MAX_PER_REPO_PER_TICK bounds worst-case
  // per-tick work so a backlog of pending commits drains over multiple
  // ticks. BUDGET_THRESHOLD is the headroom under
  // BITBUCKET_HOURLY_CALL_BUDGET that the inner loop respects — lower than
  // the commit-tick threshold because diff-stats runs after the commit
  // batch has already consumed budget.
  DIFF_STATS_MAX_PER_REPO_PER_TICK: z.coerce.number().int().positive().default(50),
  DIFF_STATS_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
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
