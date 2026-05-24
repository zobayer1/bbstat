// CLI utility: forces a full recompute of both ShipShow Score rollups —
// per-alias `user_score` AND per-person `person_score` (Phase 5). The
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
// Run from the repo root: `make recompute-user-scores` (target name
// retained for muscle memory; both tables get recomputed regardless).

/* eslint-disable no-console -- CLI utility, console output is the deliverable */

import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { recomputeAllScores } from '../scoring/rollup.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  console.log(`→ Recomputing user_score + person_score from commits…`);
  try {
    const { user, person } = await recomputeAllScores({ db });
    console.log(
      `✓ Recomputed ${user.devsProcessed} user_score rows (${user.durationMs}ms) ` +
        `and ${person.peopleProcessed} person_score rows (${person.durationMs}ms).`,
    );
    process.exit(0);
  } catch (err) {
    console.error(`✗ Recompute failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
