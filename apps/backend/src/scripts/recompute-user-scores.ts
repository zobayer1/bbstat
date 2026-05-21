// CLI utility: forces a full recompute of the `user_score` rollup. The
// sync runner fires this at the end of every commits-sync tick, and the
// admin endpoint `POST /api/admin/scores/recompute` exposes the same
// operation over HTTP. This script is the shell equivalent — useful for
// backfills after threshold tuning, the post-deploy verification step,
// and the dev smoke loop.
//
// Mirrors src/scripts/rebuild-rollups.ts: shipped as a script (not an
// HTTP admin endpoint) is fine, but the endpoint exists too. The two are
// equivalent — pick whichever fits the operator's environment.
//
// Run from the repo root: `make recompute-user-scores` (target added in
// the Makefile alongside the existing rebuild-rollups one).

/* eslint-disable no-console -- CLI utility, console output is the deliverable */

import { createCache } from '../cache/redis.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { recomputeUserScores } from '../scoring/rollup.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const cache = createCache(config.REDIS_URL);

  console.log(`→ Recomputing user_score from commits…`);
  try {
    const result = await recomputeUserScores({ db, cache });
    console.log(
      `✓ Recomputed ${result.devsProcessed} user_score rows in ${result.durationMs}ms ` +
        `(${result.cacheKeysDeleted} leaderboard cache key(s) invalidated).`,
    );
    process.exit(0);
  } catch (err) {
    console.error(`✗ Recompute failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
