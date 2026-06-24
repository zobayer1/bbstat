// Endpoint wrapper for `/repositories/{ws}/{slug}/commits` — typed shape +
// paginator. Sync orchestration lives in src/sync/commits.ts.

import type { BitbucketClient } from './client.js';

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

// Paginated endpoint → `values.` prefix required; `next` is appended by
// client.paginate().
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
  // Branch name or commit SHA to walk history from. Omitted → main branch.
  include?: string;
}

// Yields commits in BitBucket's natural order (newest first). Caller decides
// when to stop (known sha for delta sync, or N pages for first-run backfill).
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
