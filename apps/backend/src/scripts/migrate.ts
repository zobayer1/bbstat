// Programmatic Drizzle migrator against DATABASE_URL. Idempotent — the
// __drizzle_migrations journal tracks what's applied, so re-running is a no-op.
//
// This is the runtime entrypoint inside the production image (where drizzle-kit
// isn't installed; local dev's `make db-migrate` uses drizzle-kit instead). The
// compose stack runs it as a one-shot at boot; exit 1 on failure lets
// `depends_on: service_completed_successfully` gate the dependent containers.

/* eslint-disable no-console -- one-shot CLI; stdout/stderr is the deliverable */

import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('✗ DATABASE_URL must be set');
    process.exit(1);
  }

  // `../../drizzle` resolves the same from src/scripts (dev `tsx`) and
  // dist/scripts (prod image copies drizzle/ alongside dist/).
  const migrationsFolder = resolve(import.meta.dirname, '..', '..', 'drizzle');

  console.log(`→ Applying migrations from ${migrationsFolder}`);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder });
    console.log('✓ Migrations applied');
  } catch (err) {
    console.error('✗ Migration failed');
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
