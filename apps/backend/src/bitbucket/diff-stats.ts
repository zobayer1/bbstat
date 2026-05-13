// Endpoint wrapper for BitBucket Cloud
// `/repositories/{ws}/{slug}/diffstat/{sha}` — typed shape + per-commit
// summer. Sync orchestration (per-repo opt-in gate, budget-aware pickup,
// idempotent UPDATE on commits.additions/deletions/diff_stats_synced_at)
// lives in src/sync/diff-stats.ts and consumes this.
//
// Phase 4 T21: we collapse the per-file paginated response to a single
// `{ additions, deletions }` total at commit granularity — that's what
// the dashboard reads. Per-file detail is intentionally discarded; if
// the BB API ever returns null for binary files we treat it as zero.

import type { BitbucketClient } from './client.js';

// Slim per-file diff entry — only the fields we field-filter for. The full
// BB shape carries `type`, `status`, `old`, `new`, etc.; none of that is
// needed at commit granularity.
export interface BitbucketDiffStatEntry {
  lines_added: number | null;
  lines_removed: number | null;
}

// Field filter for /diffstat. Paginated endpoint → `values.` prefix required;
// `next` is appended automatically by client.paginate().
export const DIFF_STAT_FIELDS = ['values.lines_added', 'values.lines_removed'];

export interface CommitDiffStat {
  additions: number;
  deletions: number;
}

// One BB call per page (typically 1 for small commits; multi-file commits
// may paginate). Pure — doesn't touch the database. Caller decides when to
// persist and how to budget; this wrapper just makes the call.
export async function getCommitDiffStat(
  client: BitbucketClient,
  workspace: string,
  slug: string,
  sha: string,
): Promise<CommitDiffStat> {
  let additions = 0;
  let deletions = 0;
  for await (const entry of client.paginate<BitbucketDiffStatEntry>(
    `/repositories/${workspace}/${slug}/diffstat/${sha}`,
    { fields: DIFF_STAT_FIELDS },
  )) {
    additions += entry.lines_added ?? 0;
    deletions += entry.lines_removed ?? 0;
  }
  return { additions, deletions };
}
