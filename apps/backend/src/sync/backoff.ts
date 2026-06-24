// Adaptive sync backoff: skip the per-tick BB call for a repo that
// hasn't received activity recently and was polled within the computed
// interval. Linear — the interval grows as `slope * days_quiet`, clamped
// to [min, max] minutes.
//
// Rationale: at scale (~100+ repos) most are quiet most of the time.
// Polling them at the active 5-min cadence wastes budget and starves the
// fair round-robin rotation. Self-healing: a new commit resets the
// activity timestamp, so the next tick's interval is back to the floor —
// the formula just reads MAX(activity) each tick, no reclassification.
//
// Empty / never-active repos fall back to `created_at` as the reference
// point, so a freshly-added empty repo still polls fast and only backs
// off as it ages.

export interface BackoffOptions {
  // Minutes added per day of quiet. Default 4 → 30 days ≈ 2h, 365 ≈ 24h.
  slopeMinPerQuietDay: number;
  // Floor on the interval. Default 5 (matches the commit cron cadence).
  minIntervalMin: number;
  // Ceiling on the interval. Default 1440 (24h) so even a years-dead
  // repo gets at least a daily check.
  maxIntervalMin: number;
}

export interface IsDueForSyncArgs {
  // When the relevant sync last polled this repo. `null` = never → due.
  lastSyncedAt: Date | null;
  // Activity timestamp the backoff is keyed on (MAX(commits.authored_at)
  // for commit sync, MAX(pull_requests.bitbucket_updated_at) for PRs).
  // `null` = no activity ever ingested; falls back to `createdAt`.
  latestActivityAt: Date | null;
  // Activity-floor when `latestActivityAt` is null — otherwise a repo
  // with no commits and a 5-min interval polls every tick forever.
  createdAt: Date;
  // Injectable for tests; production passes new Date().
  now: Date;
}

export function isDueForSync(opts: BackoffOptions, args: IsDueForSyncArgs): boolean {
  if (args.lastSyncedAt === null) return true;

  const reference = args.latestActivityAt ?? args.createdAt;
  const daysQuiet = Math.max(0, (args.now.getTime() - reference.getTime()) / 86_400_000);
  const intervalMin = Math.min(
    opts.maxIntervalMin,
    Math.max(opts.minIntervalMin, daysQuiet * opts.slopeMinPerQuietDay),
  );
  const minutesSinceSync = (args.now.getTime() - args.lastSyncedAt.getTime()) / 60_000;
  return minutesSinceSync >= intervalMin;
}
