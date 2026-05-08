import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
  const https = {
    key: readFileSync(resolve(repoRoot, config.TLS_KEY_PATH)),
    cert: readFileSync(resolve(repoRoot, config.TLS_CERT_PATH)),
  };

  const app = await buildApp({ config, https });

  try {
    await app.listen({ host: '0.0.0.0', port: config.BACKEND_PORT });
    app.log.info(`Listening on https://${config.BACKEND_HOST}:${config.BACKEND_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
