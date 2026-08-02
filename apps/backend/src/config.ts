import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_HOST: z.string().default('bbstat.localhost'),
  BACKEND_PORT: z.coerce.number().int().positive().default(8443),
  // TLS toggle. 'on' (default): backend terminates HTTPS itself against the
  // self-signed cert under etc/tls/ (TLS_KEY_PATH / TLS_CERT_PATH must be
  // readable). 'off': TLS terminated upstream (Traefik / prod reverse proxy),
  // backend listens on plain HTTP behind it.
  BACKEND_TLS: z.enum(['on', 'off']).default('on'),
  TLS_KEY_PATH: z.string().default('etc/tls/server.key'),
  TLS_CERT_PATH: z.string().default('etc/tls/server.crt'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  BITBUCKET_BASE_URL: z.string().url().default('https://api.bitbucket.org/2.0'),
  BITBUCKET_WORKSPACE: z.string().optional(),
  BITBUCKET_AUTH_EMAIL: z.string().optional(),
  BITBUCKET_AUTH_TOKEN: z.string().optional(),
  // Soft cap on outbound BitBucket calls per rolling hour. BB Cloud's
  // documented per-identity limit is ~1000/hr; we run at the full cap since
  // the gate is conservative. See memory/bitbucket_rate_limit_headers.md.
  BITBUCKET_HOURLY_CALL_BUDGET: z.coerce.number().int().positive().default(1000),
  // Minimum wall-clock interval between successive BB calls. BB's documented
  // 1000/hr cap hides a sub-second burst limiter that 429s above ~2-3
  // calls/sec. 400ms (≈ 2.5/sec) stays under that without dragging out
  // single-call admin endpoints. 0 disables (test envs).
  BITBUCKET_MIN_CALL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(400),
  // Hard ceiling for adaptive pacing. Each 429 doubles the current interval
  // (400 → 800 → 1600 → 3200), capped here. When capped and 429s persist,
  // the retry budget exhausts and `BitbucketRateLimitError` propagates — the
  // tick orchestrators treat that as a stop signal and defer remaining repos.
  BITBUCKET_MAX_CALL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3200),

  // Path to the curated tracked-repository seed file (YAML), resolved against
  // the repo root if relative. Unset defaults to `tracked-repos.yaml` and a
  // missing default file is a no-op (admins add repos via POST
  // /api/admin/repositories). If explicitly set, the file must exist or
  // startup fails loud.
  SEED_REPO_FILE_PATH: z.string().optional(),

  // Cron schedules. Defaults are tight to make crons easy to observe during
  // dev; lengthen them in production once we trust the runner.
  SYNC_MEMBERS_CRON: z.string().default('*/10 * * * *'),
  SYNC_REPOS_CRON: z.string().default('*/5 * * * *'),
  // Commit cron also drives the piggybacked deepen-backfill step.
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

  // Cold-repo admission cap for the commit + PR sync ticks. A "cold" repo
  // has never been synced, so backoff can't apply (no activity signal) and it
  // sorts to the head of the NULLS-FIRST queue. A bulk discovery sweep can
  // dump hundreds of cold repos at once; without a cap they monopolize the
  // queue and budget every tick, starving the warm active rotation. Warm
  // repos are serviced first and in full; only this many cold repos are
  // admitted per tick, so a discovery backlog backfills gradually in leftover
  // budget. Set 0 to pause cold first-syncs; raise to drain a backlog faster.
  SYNC_MAX_COLD_REPOS_PER_TICK: z.coerce.number().int().nonnegative().default(5),

  // Per-commit diff-stat ingest (1 BB call per file-page of a commit's
  // /diffstat). Two parallel paths share the inner walker:
  //
  //   * Inline-eager (forward) — runs inside the per-repo commit sync against
  //     commits just inserted this tick. `DIFF_STATS_BUDGET_THRESHOLD` is the
  //     headroom below the hourly cap before the loop bails — lower than the
  //     commit-tick threshold because the commit batch already consumed budget.
  //
  //   * Backfill (backward) — own tick after deepen + is-merge. Global
  //     newest-first pickup across every non-archived non-excluded repo.
  //     `MAX_COMMITS_PER_TICK` caps total work per tick. `BUDGET_THRESHOLD`
  //     sits slightly above the commit-tick threshold so we never starve the
  //     next cron tick's commit ingest.
  DIFF_STATS_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
  DIFF_STATS_BACKFILL_MAX_COMMITS_PER_TICK: z.coerce.number().int().positive().default(100),
  DIFF_STATS_BACKFILL_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Retroactive is_merge backfill tick. Drains the pre-V1_7 backlog of
  // `commits.is_merge = false` rows that should have been true. Runs after
  // deepen and before diff-stats backfill, sharing the hourly call budget.
  // BUDGET_THRESHOLD sits between deepen's (100) and diff-stats backfill's
  // (20): is-merge gets the leftover budget after deepen but yields to it
  // (extending unknown history > correcting known rows).
  IS_MERGE_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  IS_MERGE_BACKFILL_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(50),

  // PR ingest on its own cron (default hourly — PRs mutate slower than
  // commits, and at 160-repo scale every PR tick is ~160 BB calls). Cold-mode
  // cap is 5 pages × 100 = 500 PRs per repo on first sync; then delta.
  //
  // `SYNC_PRS_ENABLED` gates the cron registration only — the admin manual
  // trigger (`POST /api/admin/sync/prs`) always works. Default `false`: the
  // PR backlog is ingested and mutations are rare, so the hourly tick burns
  // budget for near-zero delta. Set `true` to re-enable scheduled ingest.
  SYNC_PRS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SYNC_PRS_CRON: z.string().default('0 * * * *'),
  // Auto-track workspace repos via the discovery sweep
  // (src/sync/repo-discovery.ts). Default `false`. Gates the cron sweep only —
  // the admin dry-run preview (`POST /api/admin/sync/discover-repos`) works
  // regardless. Enabling walks GET /repositories/{workspace} by updated_on
  // (oldest first, Redis cursor) and tracks every untracked repo (external
  // forks excluded) through the normal cold / deepen / backoff path.
  REPO_DISCOVERY_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  PR_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  PR_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  PR_SYNC_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Self-queueing deepen-backfill, piggybacked on the commit cron. After the
  // delta tick, if budget headroom ≥ DEEPEN_BUDGET_THRESHOLD, the runner picks
  // ONE repo whose `deepen_complete` is false and walks one bounded backfill
  // page backwards from its oldest known commit. Once BB has nothing older,
  // `deepen_complete` flips true and it leaves the queue. Threshold is higher
  // than the commit-tick gate (20) so deepen yields to delta sync.
  DEEPEN_BACKFILL_MAX_PAGES: z.coerce.number().int().positive().default(5),
  DEEPEN_BUDGET_THRESHOLD: z.coerce.number().int().nonnegative().default(100),

  // Grace window before a still-empty repo is auto-excluded from sync
  // (reason 'empty-on-bitbucket'). A repo with 0 commits at discovery —
  // e.g. one added moments before its first push — would otherwise be
  // excluded by the very next deepen tick and go dark until an operator
  // runs /sync/revive-empty. Anchored on repositories.created_at (when we
  // first tracked it); within the window the repo stays in active sync so
  // the commit tick keeps probing and catches the first commit on its own.
  // Set to 0 to restore the old immediate-exclusion behavior.
  SYNC_EMPTY_GRACE_HOURS: z.coerce.number().nonnegative().default(24),

  // Read-only MCP server (apps/backend/src/mcp) — separate compose service on
  // the same backend image. Consumed ONLY by the mcp role; backend / sync /
  // migrate ignore them. Kept optional so the shared config schema parses for
  // every role — the mcp entrypoint fail-louds on a missing MCP_TOKEN_SECRET.
  //
  // TLS follows the BACKEND_TLS toggle: 'on' (host dev) makes mcp terminate
  // HTTPS itself with the shared cert; 'off' (container) serves plain HTTP
  // behind the reverse proxy. MCP_HOST mirrors BACKEND_HOST (bbstat.localhost
  // for dev, overridden to 0.0.0.0 in-container).
  MCP_HOST: z.string().default('bbstat.localhost'),
  MCP_PORT: z.coerce.number().int().positive().default(8090),
  // HMAC key that signs + verifies consumer access tokens. No default: the
  // server refuses to start without it. Rotating it invalidates every
  // previously minted token (the only revocation mechanism — tokens are
  // stateless, no DB).
  MCP_TOKEN_SECRET: z.string().optional(),

  // Comma-separated org email domains (e.g. "acme.com,acme.co.uk"). The
  // Members classification treats a contributor at one of these domains as a
  // workspace member (never "external"), even when their commit account isn't
  // in the BB member roster and isn't merged. Empty (the default) disables the
  // heuristic, so only flagged / merged / overridden accounts count as members.
  // The operator override (POST /admin/users/:id/override) covers accounts
  // outside it.
  ORG_EMAIL_DOMAINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0),
    ),

  // Comma-separated name tokens stripped before duplicate-account matching in
  // the `find:duplicates` CLI — honorifics and naming-convention prefixes that
  // carry no identifying signal. The default covers common English honorifics
  // plus the South Asian "Md./Mohammad" prefixes, so "Md. Alex Rivera"
  // matches "Alex Rivera". Set this to replace the list wholesale with
  // whatever your org's naming conventions call for.
  NAME_NOISE_TOKENS: z
    .string()
    .default('md,mohd,mohammad,mohammed,mohammod,muhammad,mr,mrs,ms,dr,engr,eng,prof')
    .transform((v) =>
      v
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    ),
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
