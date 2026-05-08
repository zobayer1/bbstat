import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  // .env lives at the monorepo root, not in apps/frontend/. Point both Vite's
  // automatic env loading (envDir) and the explicit loadEnv() call at the
  // repo root so VITE_* vars resolve consistently in dev/build/preview.
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const env = loadEnv(mode, repoRoot, '');
  const port = Number(env.VITE_DEV_PORT) || 5173;

  return {
    envDir: repoRoot,
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
