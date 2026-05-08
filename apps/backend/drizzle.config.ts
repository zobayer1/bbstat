import { defineConfig } from 'drizzle-kit';

// drizzle-kit doesn't honor --env-file flags itself. Load .env manually so
// `make db-generate` / `make db-migrate` work without extra env plumbing.
try {
  process.loadEnvFile('../../.env');
} catch {
  // .env may not exist (CI, fresh checkout) — rely on the ambient environment.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set in .env at the repo root, or as an env var.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
