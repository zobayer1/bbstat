import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_HOST: z.string().default('bbstat.localhost'),
  BACKEND_PORT: z.coerce.number().int().positive().default(8443),
  // TLS toggle. In local dev the backend terminates HTTPS itself against the
  // self-signed cert under etc/tls/. In containerized deployments TLS is
  // terminated upstream (Traefik in dev-stack, the production reverse proxy
  // in prod), and the backend listens on plain HTTP behind it. Set 'off' in
  // those environments. When 'on' (the default), TLS_KEY_PATH / TLS_CERT_PATH
  // must resolve to readable files.
  BACKEND_TLS: z.enum(['on', 'off']).default('on'),
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
  // we run at the full cap by default since the gate is conservative (BB's
  // rolling window is generous) and we'd rather use the headroom. See
  // memory/bitbucket_rate_limit_headers.md.
  BITBUCKET_HOURLY_CALL_BUDGET: z.coerce.number().int().positive().default(1000),
  // Minimum wall-clock interval between successive BB calls from this
  // client. BB's documented 1000/hr cap hides a sub-second burst limiter
  // that 429s when we issue calls faster than ~2-3 per second. 400ms
  // (≈ 2.5 calls/sec) keeps us comfortably under that without dragging out
  // single-call admin endpoints. Set to 0 to disable in test envs.
  BITBUCKET_MIN_CALL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(400),
  // Hard ceiling for adaptive pacing. Each observed 429 doubles the
  // current interval (400 → 800 → 1600 → 3200 by default), capped here.
  // When the cap is reached and 429s persist, the BB client's retry
  // budget exhausts and `BitbucketRateLimitError` propagates — which the
  // tick orchestrators (commits + deepen) treat as a stop signal,
  // deferring remaining repos to the next cron tick.
  BITBUCKET_MAX_CALL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3200),

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
  // Commit cron also drives the piggybacked deepen-backfill step (see
  // `DEEPEN_BUDGET_THRESHOLD` below). 5-minute cadence is comfortable
  // under the hourly call budget for a curated tracked set of ~30 repos.
  SYNC_COMMITS_CRON: z.string().default('*/5 * * * *'),

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

  // Adaptive backoff for the commit + PR sync cron ticks. Linear slope:
  // every day a repo has been quiet (no new commits / PRs) adds
  // SLOPE_MIN_PER_QUIET_DAY minutes to its minimum polling interval,
  // clamped to [MIN, MAX]. Defaults: 4 min/day, [5, 1440] → an idle
  // repo's interval grows from 5 min (today) to 2h (30d) to 24h
  // (365d+). Pure short-circuit: a repo whose interval hasn't elapsed
  // is skipped this tick without any BB call. Diff-stats backfill and
  // deepen are NOT affected — both have their own orthogonal queues
  // and run as long as budget allows. Manual admin sync triggers also
  // bypass backoff (they hit syncRepositoryCommits directly).
  SYNC_BACKOFF_SLOPE_MIN_PER_QUIET_DAY: z.coerce.number().nonnegative().default(4),
  SYNC_BACKOFF_MIN_INTERVAL_MIN: z.coerce.number().nonnegative().default(5),
  SYNC_BACKOFF_MAX_INTERVAL_MIN: z.coerce.number().int().positive().default(1440),

  // Per-commit diff-stat ingest (1 BB call per file-page of a commit's
  // /diffstat). Two parallel paths share the inner walker:
  //
  //   * Inline-eager (forward) — runs inside the per-repo commit sync
  //     against the commits *just inserted* on this tick.
  //     `DIFF_STATS_BUDGET_THRESHOLD` is the headroom below the hourly
  //     cap before the loop bails. Lower than the commit-tick threshold
  //     because this runs after the commit batch has already consumed
  //     budget.
  //
  //   * Backfill (backward) — own tick after deepen + is-merge. Uses a
  //     global newest-first pickup across every non-archived
  //     non-excluded repo (no per-repo iteration; freshness rules).
  //     `MAX_COMMITS_PER_TICK` caps total work per tick (was
  //     per-repo before the 2026-05 rewrite). `BUDGET_THRESHOLD` is
  //     the safety margin against running to zero — slightly above
  //     the commit-tick threshold so we never starve the next cron
  //     tick's commit ingest.
  DIFF_STATS_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
  DIFF_STATS_BACKFILL_MAX_COMMITS_PER_TICK: z.coerce.number().int().positive().default(100),
  DIFF_STATS_BACKFILL_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Retroactive is_merge backfill tick. Drains the pre-V1_7 backlog of
  // `commits.is_merge = false` rows that should have been true (the
  // migration set the default to false on every already-ingested row).
  // Runs after deepen and before diff-stats backfill, sharing the same
  // hourly call budget. MAX_PAGES caps per-repo per-tick work the same
  // way deepen does. BUDGET_THRESHOLD sits between deepen's (100) and
  // diff-stats backfill's (20): is-merge gets first crack at the
  // leftover budget after deepen, but yields to deepen which is the
  // higher priority (extending unknown history > correcting known
  // rows).
  IS_MERGE_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  IS_MERGE_BACKFILL_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(50),

  // Phase 4 T22: PR ingest. Runs on its own cron (default hourly — PRs
  // mutate slower than commits, and at 160-repo scale every PR tick is
  // ~160 BB calls, so spending 30 min cadence on a low-PR-traffic
  // workspace is wasteful). Cold-mode cap is 5 pages × 100 = 500 PRs per
  // repo on first sync; subsequent runs walk delta.
  //
  // `SYNC_PRS_ENABLED` is a kill switch on the cron registration only —
  // the admin manual trigger (`POST /api/admin/sync/prs`) always works,
  // so an operator can run a one-shot tick without touching env. Default
  // is `false`: at TigerIT scale the PR backlog has been ingested and
  // mutations are rare, so the hourly tick burns budget for near-zero
  // delta. Set to `true` to re-enable scheduled ingest.
  SYNC_PRS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SYNC_PRS_CRON: z.string().default('0 * * * *'),
  PR_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  PR_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  PR_SYNC_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Self-queueing deepen-backfill: piggybacks on the commit cron. After
  // the normal delta tick finishes, if the BB-call budget still has at
  // least DEEPEN_BUDGET_THRESHOLD headroom, the runner picks ONE repo
  // whose `sync_state.deepen_complete` is still false and walks one
  // bounded backfill page (DEEPEN_BACKFILL_MAX_PAGES × 100 commits)
  // backwards from its oldest known commit. Once BB has nothing older
  // for a repo, its `deepen_complete` flips true and it leaves the queue.
  //
  // Threshold is intentionally higher than the regular commit-tick gate
  // (20) — deepen yields to delta sync. A reasonable default that still
  // makes steady progress without crowding the budget.
  DEEPEN_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  DEEPEN_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(100),
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
