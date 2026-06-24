import { createApp } from 'vue';
import App from './App.vue';
import { bustStaleCacheIfNeeded } from './lib/cache-bust';
import { router } from './router';
import { createStore } from './stores';
import './styles/main.css';

// MUST run before app.use(createStore()) — once a store hydrates from
// localStorage the in-memory shape is locked for the session, and a later
// bust would only fix the next reload.
bustStaleCacheIfNeeded();

const app = createApp(App);
app.use(createStore());
app.use(router);
app.mount('#app');
