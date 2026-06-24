// CLI: forces a full recompute of both ShipShow Score rollups — per-alias
// `user_score` and per-person `person_score`. Equivalent to the sync tick tail
// and the `POST /api/admin/scores/recompute` endpoint; useful for backfills
// after threshold tuning and post-deploy verification.
//
// `make recompute-user-scores` (target name kept for muscle memory; both
// tables get recomputed regardless).

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
