import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig(({ command, mode }) => {
  // .env lives at the monorepo root, not in apps/frontend/. Point both Vite's
  // automatic env loading (envDir) and the explicit loadEnv() call at the
  // repo root so VITE_* vars resolve consistently in dev/build/preview.
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const env = loadEnv(mode, repoRoot, '');
  const port = Number(env.VITE_DEV_PORT) || 5173;

  // TLS is only relevant for `vite` (dev server). Two gates:
  //   1. `command === 'serve'` — `vite build` runs in the frontend image
  //      where the self-signed cert isn't present (dockerignored), so we
  //      must not read those files at build time.
  //   2. `FRONTEND_TLS !== 'off'` — symmetric to the backend's BACKEND_TLS
  //      toggle. Set both to `off` for the "local HTTP" workflow (browsers
  //      block mixed content, so the two have to flip together).
  // In the containerized stack nginx + the upstream reverse proxy own TLS;
  // this branch never runs.
  const devHttps =
    command === 'serve' && env.FRONTEND_TLS !== 'off'
      ? {
          key: readFileSync(resolve(repoRoot, 'etc/tls/server.key')),
          cert: readFileSync(resolve(repoRoot, 'etc/tls/server.crt')),
        }
      : undefined;

  return {
    envDir: repoRoot,
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host: 'bbstat.localhost',
      port,
      ...(devHttps ? { https: devHttps } : {}),
    },
    preview: {
      host: 'bbstat.localhost',
      port,
    },
  };
});
