// CLI: re-aggregates `commit_daily` from all of `commits` via one unscoped
// UPSERT, reconciling drift when commits land outside the wrapped sync path
// (raw SQL imports, restored backups). Idempotent. `make rebuild-rollups`.
//
// A script, not an HTTP endpoint, because the deployment has no auth yet —
// shell access is a sharper authz fence for a destructive-shaped operation.
// Logic lives on RollupStore.rebuildAll so a future admin route can reuse it.

/* eslint-disable no-console -- CLI utility, console output is the deliverable */

import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { createDrizzleRollupStore } from '../dashboard/rollup-store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const store = createDrizzleRollupStore(db);

  console.log(`→ Rebuilding commit_daily from commits…`);
  const start = Date.now();
  try {
    const { rowsAffected } = await store.rebuildAll();
    const elapsedMs = Date.now() - start;
    console.log(`✓ Rebuilt ${rowsAffected} (day, repo, user) buckets in ${elapsedMs}ms.`);
    console.log(``);
    console.log(`Note: this UPSERTs every active bucket but does NOT prune orphan`);
    console.log(`rollup rows whose backing commits were deleted out-of-band. The repo`);
    console.log(`FK cascade handles repo removals; only manual DELETE FROM commits`);
    console.log(`without rollup cleanup would leave stale rows behind.`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
