import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { createStore } from './stores';
import './styles/main.css';

const app = createApp(App);
app.use(createStore());
app.use(router);
app.mount('#app');
