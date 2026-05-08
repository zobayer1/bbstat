// Endpoint wrapper for BitBucket Cloud `/repositories/{ws}/{slug}/commits`
// — typed shape + paginator. Sync orchestration (delta pull, cursor handling,
// idempotent upserts) lives in src/sync/commits.ts and consumes this.

import type { BitbucketClient } from './client.js';

// Slim BitBucket commit shape — only the fields we field-filter for.
// `author.user` is absent for anonymous / unmatched authors; downstream sync
// logic must handle that (commits.author_user_id is nullable).
export interface BitbucketCommit {
  hash: string;
  message: string;
  date: string;
  parents: Array<{ hash: string }>;
  author: {
    raw: string;
    user?: {
      uuid: string;
      display_name?: string;
    };
  };
}

// Field filter for /commits. Paginated endpoints require the `values.`
// prefix; `next` is appended automatically by client.paginate().
export const COMMIT_LIST_FIELDS = [
  'values.hash',
  'values.message',
  'values.date',
  'values.parents.hash',
  'values.author.raw',
  'values.author.user.uuid',
  'values.author.user.display_name',
];

export interface PaginateCommitsOptions {
  // A branch name or commit SHA to walk history from. When omitted, BitBucket
  // returns commits reachable from the repository's main branch.
  include?: string;
}

// Async iterator yielding each commit in BitBucket's natural order (newest
// first). Caller decides when to stop — e.g., on hitting a known sha for
// delta sync, or after N pages on first-run backfill.
export function paginateCommits(
  client: BitbucketClient,
  workspace: string,
  slug: string,
  opts: PaginateCommitsOptions = {},
): AsyncGenerator<BitbucketCommit, void, void> {
  const query: Record<string, string | undefined> = {};
  if (opts.include !== undefined) query.include = opts.include;

  return client.paginate<BitbucketCommit>(`/repositories/${workspace}/${slug}/commits`, {
    fields: COMMIT_LIST_FIELDS,
    query,
  });
}
