import { createApp } from 'vue';
import App from './App.vue';
import { bustStaleCacheIfNeeded } from './lib/cache-bust';
import { router } from './router';
import { createStore } from './stores';
import './styles/main.css';

// MUST run before app.use(createStore()) so the wipe happens before any
// store hydrates from localStorage. After hydration the in-memory shape
// is locked in for the session — a later bust would only fix the next
// reload.
bustStaleCacheIfNeeded();

const app = createApp(App);
app.use(createStore());
app.use(router);
app.mount('#app');
