import { defineTool } from './types.js';

export const getOverviewTool = defineTool({
  name: 'get_overview',
  title: 'Org overview',
  description:
    'Workspace-wide headline statistics: total tracked repositories, commits, contributors, and recent-activity totals. Takes no arguments. Good first call to ground a summary before drilling into a specific contributor, repo, or project.',
  inputShape: {},
  async handler(store) {
    return store.getOverview();
  },
});
