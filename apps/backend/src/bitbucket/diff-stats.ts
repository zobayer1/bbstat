// Endpoint wrapper for BitBucket Cloud
// `/repositories/{ws}/{slug}/diffstat/{sha}` — typed shape + per-commit
// summer. Sync orchestration (per-repo opt-in gate, budget-aware pickup,
// idempotent UPDATE on commits.additions/deletions/files_changed/
// diff_stats_synced_at) lives in src/sync/diff-stats.ts and consumes this.
//
// Phase 4 T21: we collapse the per-file paginated response to a single
// `{ additions, deletions, filesChanged }` total at commit granularity —
// that's what the dashboard reads. Per-file detail is intentionally
// discarded; if the BB API ever returns null for binary files we treat
// the line counts as zero (the entry still contributes to filesChanged).

import { buildMatcher, type Matcher } from './diff-stats-filter.js';
import type { BitbucketClient } from './client.js';

// Slim per-file diff entry — only the fields we field-filter for. The full
// BB shape carries `type`, `status`, etc.; only line counts + paths are
// needed at commit granularity. `new` is set for additions / modifications
// / renames' destination; `old` is set for deletions / renames' source.
// Renames populate both; either side matching an exclude pattern is
// enough to skip the entry.
export interface BitbucketDiffStatEntry {
  lines_added: number | null;
  lines_removed: number | null;
  new?: { path?: string | null } | null;
  old?: { path?: string | null } | null;
}

// Field filter for /diffstat. Paginated endpoint → `values.` prefix required;
// `next` is appended automatically by client.paginate(). `values.new.path`
// and `values.old.path` are needed by the per-repo exclude filter; cheap
// to include even when no patterns are configured.
export const DIFF_STAT_FIELDS = ['values.lines_added', 'values.lines_removed', 'values.new.path', 'values.old.path'];

export interface CommitDiffStat {
  additions: number;
  deletions: number;
  filesChanged: number;
}

// One BB call per page (typically 1 for small commits; multi-file commits
// may paginate). Pure — doesn't touch the database. Caller decides when to
// persist and how to budget; this wrapper just makes the call.
//
// `excludePatterns` is the per-repo file-path blacklist (picomatch globs,
// sourced from `repositories.diff_stats_exclude_patterns`). Entries whose
// new.path OR old.path matches are skipped entirely — they contribute
// 0 to additions / deletions / filesChanged. Empty array = pass-through.
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
