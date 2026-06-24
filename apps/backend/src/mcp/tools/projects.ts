import { z } from 'zod';
import { defineTool, ToolError } from './types.js';

export const projectStatsTool = defineTool({
  name: 'get_project_stats',
  title: 'Project stats',
  description:
    'Aggregate statistics for one project (a group of repositories sharing a project key): totals across its repos, contributor breakdown, and per-repo rollup. Find valid project keys on the `project` field of list_repositories rows. Errors if no repositories carry the given key.',
  inputShape: {
    project_key: z.string().min(1).describe('Project key from a repository row, e.g. "BBSTAT".'),
  },
  async handler(store, args) {
    const stats = await store.getProjectStats(args.project_key);
    if (stats === null) {
      throw new ToolError(
        `No project found with key ${args.project_key}. Project keys appear on list_repositories rows.`,
      );
    }
    return stats;
  },
});
