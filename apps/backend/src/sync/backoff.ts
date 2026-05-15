// Adaptive sync backoff: skip the per-tick BB call for a repo when it
// hasn't received activity recently and was already polled within the
// computed interval. Linear backoff — the interval grows as `slope *
// days_quiet`, clamped to [min, max] minutes.
//
// Rationale: at scale (~100+ tracked repos) most are quiet most of the
// time. Polling them at the same 5-min cadence as active repos wastes
// budget *and* starves the active rotation (fair round-robin promotes
// the longest-unsynced first). Backoff puts quiet repos at a lower
// effective cadence without a hard tiered cutoff.
//
// Self-healing: a quiet repo that gets a new commit immediately resets
// its activity timestamp; next tick its interval is back to
// `minIntervalMin`. No reclassification logic needed — the formula
// just reads MAX(activity) each tick.
//
// Empty / never-active repos: fall back to the repo's `created_at` as
// the reference point. A repo we added today polls every 5 min;
// a repo we added a year ago that never produced any commits backs off
// to daily, same as a repo that *had* commits but stopped a year ago.

export interface BackoffOptions {
  // Minutes added to the polling interval per day of quiet. Linear scale.
  // Default 4 → 30 days quiet ≈ 2h, 365 days quiet ≈ 24h.
  slopeMinPerQuietDay: number;
  // Floor on the interval. A repo never polls faster than this even if
  // it has activity in the last hour. Default 5 (matches the default
  // commit cron cadence).
  minIntervalMin: number;
  // Ceiling on the interval. Default 1440 (24h) so even a years-dead
  // repo gets at least a daily check.
  maxIntervalMin: number;
}

export interface IsDueForSyncArgs {
  // When was this repo last polled by the relevant sync (commit-list
  // sync for commits, PR sync for PRs)? `null` = never been synced →
  // always due.
  lastSyncedAt: Date | null;
  // The latest activity timestamp the backoff is keyed on:
  //   - commit-list backoff: MAX(commits.authored_at)
  //   - PR backoff: MAX(pull_requests.bitbucket_updated_at)
  // `null` = no activity ever ingested (or no commits in the table for
  // a brand-new tracked repo). Falls back to `createdAt`.
  latestActivityAt: Date | null;
  // When the repo row was added to our DB. Used as the activity-floor
  // when `latestActivityAt` is null — otherwise a repo with no commits
  // and a 5-min interval polls every tick forever.
  createdAt: Date;
  // Injectable for tests; defaults to new Date() in the production
  // call path.
  now: Date;
}

export function isDueForSync(opts: BackoffOptions, args: IsDueForSyncArgs): boolean {
  // Never-synced repos always run. The first sync establishes
  // `lastSyncedAt` and the backoff kicks in from there.
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
