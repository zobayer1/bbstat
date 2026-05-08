import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '@/views/Dashboard.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', name: 'dashboard', component: Dashboard }],
});
