import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.VITE_DEV_PORT) || 5173;
  const repoRoot = resolve(import.meta.dirname, '..', '..');

  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: 'bbstat.localhost',
      port,
      https: {
        key: readFileSync(resolve(repoRoot, 'etc/tls/server.key')),
        cert: readFileSync(resolve(repoRoot, 'etc/tls/server.crt')),
      },
    },
    preview: {
      host: 'bbstat.localhost',
      port,
    },
  };
});
