import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '@/views/Dashboard.vue';
import UserSummary from '@/views/UserSummary.vue';
import ProjectStats from '@/views/ProjectStats.vue';
import RepoActivity from '@/views/RepoActivity.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/users/:userId', name: 'user', component: UserSummary, props: true },
    { path: '/projects/:projectKey', name: 'project', component: ProjectStats, props: true },
    {
      path: '/repositories/:workspace/:slug',
      name: 'repository',
      component: RepoActivity,
      props: true,
    },
  ],
});
