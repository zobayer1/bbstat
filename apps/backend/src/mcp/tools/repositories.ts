import { z } from 'zod';
import { defineTool, ToolError } from './types.js';

// The repo directory + sync health. Also the resolver for workspace/slug,
// which get_repository_activity needs.
export const listRepositoriesTool = defineTool({
  name: 'list_repositories',
  title: 'List repositories',
  description:
    'All tracked repositories with per-repo stats and derived sync status (ok / error / never / excluded / empty), ordered by most-recent activity. Each row carries workspace + slug — use those with get_repository_activity. Includes the project key, so you can also see which repos belong to a project. Takes no arguments.',
  inputShape: {},
  async handler(store) {
    return store.listTrackedRepositoriesWithStats();
  },
});

// Per-repo activity detail. workspace/slug come from list_repositories.
export const repositoryActivityTool = defineTool({
  name: 'get_repository_activity',
  title: 'Repository activity',
  description:
    'Activity detail for one repository: commit/line totals, contributor breakdown, recent activity, and sync state. Identify the repo by workspace + slug (get them from list_repositories). Errors if the repo is not tracked.',
  inputShape: {
    workspace: z.string().min(1).describe('Workspace slug, e.g. "tigerit".'),
    slug: z.string().min(1).describe('Repository slug, e.g. "bbstat".'),
  },
  async handler(store, args) {
    const activity = await store.getRepositoryActivity(args.workspace, args.slug);
    if (activity === null) {
      throw new ToolError(
        `Repository ${args.workspace}/${args.slug} is not tracked. List tracked repos with list_repositories.`,
      );
    }
    return activity;
  },
});
