import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '@/views/Dashboard.vue';
import Members from '@/views/Members.vue';
import UserSummary from '@/views/UserSummary.vue';
import ProjectStats from '@/views/ProjectStats.vue';
import RepoActivity from '@/views/RepoActivity.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/members', name: 'members', component: Members },
    // Dedicated Activity page — lazy-loaded since it pulls in three
    // chart components and a paged store none of the other pages use.
    { path: '/activity', name: 'activity', component: () => import('@/views/Activity.vue') },
    // Projects index — lazy-loaded; pulls the sunburst chart + the
    // repo-contributors endpoint that no other page touches.
    { path: '/projects', name: 'projects', component: () => import('@/views/Projects.vue') },
    // Repositories index — lazy-loaded; full searchable / sortable
    // table of every tracked repo plus a sync-health donut.
    { path: '/repositories', name: 'repositories', component: () => import('@/views/Repositories.vue') },
    { path: '/users/:userId', name: 'user', component: UserSummary, props: true },
    // Person detail (Phase 5 alias merge) — lazy-loaded; aggregated
    // equivalent of the user page over a merged person's attached aliases.
    { path: '/people/:personId', name: 'person', component: () => import('@/views/Person.vue'), props: true },
    { path: '/projects/:projectKey', name: 'project', component: ProjectStats, props: true },
    {
      path: '/repositories/:workspace/:slug',
      name: 'repository',
      component: RepoActivity,
      props: true,
    },
  ],
});
