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

// The Projects "sunburst": top repos by commits in a window, each with its top
// contributors. A distinct cross-repo aggregation — answers "which repos drove
// activity and who in each", optionally scoped to one project.
export const repoContributorBreakdownTool = defineTool({
  name: 'repo_contributor_breakdown',
  title: 'Repo × contributor breakdown',
  description:
    'Top repositories by commit count over a trailing window, each with its own top contributors (the Projects sunburst). Answers "which repos drove activity, and who within each repo". Optionally scope the pool to one project with project_key (keys are on list_repositories rows). Anonymous commits are excluded; contributor bands are keyed per entity (merged people collapse their aliases).',
  inputShape: {
    window_days: z.number().int().min(1).max(365).default(30).describe('Trailing window in days.'),
    top_repos: z.number().int().min(1).max(50).default(15).describe('Max repositories to include.'),
    top_per_repo: z.number().int().min(1).max(20).default(5).describe('Max contributors listed per repository.'),
    project: z.string().min(1).optional().describe('Optional project key to scope the repo pool to one project.'),
  },
  async handler(store, args) {
    return store.getRepoContributorBreakdown({
      windowDays: args.window_days,
      topRepos: args.top_repos,
      topPerRepo: args.top_per_repo,
      project: args.project ?? null,
    });
  },
});
