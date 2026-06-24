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
    // Lazy-loaded: pulls in three chart components + a paged store no other page uses.
    { path: '/activity', name: 'activity', component: () => import('@/views/Activity.vue') },
    // Lazy-loaded: pulls the sunburst chart + repo-contributors endpoint no other page touches.
    { path: '/projects', name: 'projects', component: () => import('@/views/Projects.vue') },
    { path: '/repositories', name: 'repositories', component: () => import('@/views/Repositories.vue') },
    { path: '/users/:userId', name: 'user', component: UserSummary, props: true },
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
