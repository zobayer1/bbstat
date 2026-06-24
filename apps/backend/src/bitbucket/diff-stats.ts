// Endpoint wrapper for `/repositories/{ws}/{slug}/diffstat/{sha}` — typed
// shape + per-commit summer. Sync orchestration lives in
// src/sync/diff-stats.ts.
//
// We collapse the per-file paginated response to a single
// `{ additions, deletions, filesChanged }` total. Per-file detail is
// discarded; null line counts (binary files) count as zero but the entry
// still contributes to filesChanged.

import { buildMatcher, type Matcher } from './diff-stats-filter.js';
import type { BitbucketClient } from './client.js';

// `new` is set for additions / modifications / renames' destination; `old`
// for deletions / renames' source. Renames populate both; either side
// matching an exclude pattern skips the entry.
export interface BitbucketDiffStatEntry {
  lines_added: number | null;
  lines_removed: number | null;
  new?: { path?: string | null } | null;
  old?: { path?: string | null } | null;
}

// Paginated endpoint → `values.` prefix required; `next` is appended by
// client.paginate(). `new.path` / `old.path` feed the per-repo exclude filter.
export const DIFF_STAT_FIELDS = ['values.lines_added', 'values.lines_removed', 'values.new.path', 'values.old.path'];

export interface CommitDiffStat {
  additions: number;
  deletions: number;
  filesChanged: number;
}

// One BB call per page (usually 1; multi-file commits may paginate). Pure —
// doesn't touch the database. `excludePatterns` entries (matching new.path OR
// old.path) contribute 0 to all three totals. Empty array = pass-through.
export async function getCommitDiffStat(
  client: BitbucketClient,
  workspace: string,
  slug: string,
  sha: string,
  excludePatterns: string[] = [],
): Promise<CommitDiffStat> {
  const isExcluded: Matcher = buildMatcher(excludePatterns);
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for await (const entry of client.paginate<BitbucketDiffStatEntry>(
    `/repositories/${workspace}/${slug}/diffstat/${sha}`,
    { fields: DIFF_STAT_FIELDS },
  )) {
    const newPath = entry.new?.path ?? null;
    const oldPath = entry.old?.path ?? null;
    if ((newPath !== null && isExcluded(newPath)) || (oldPath !== null && isExcluded(oldPath))) {
      continue;
    }
    additions += entry.lines_added ?? 0;
    deletions += entry.lines_removed ?? 0;
    filesChanged += 1;
  }
  return { additions, deletions, filesChanged };
}
