// Programmatic Drizzle migrator — runs pending SQL migrations against the
// database pointed at by DATABASE_URL. Idempotent: drizzle's __drizzle_migrations
// journal tracks what's been applied, so re-running is a no-op once caught up.
//
// Local dev: `make db-migrate` still calls drizzle-kit (devDep). This script is
// the runtime entrypoint inside the production image, where drizzle-kit is not
// installed. The compose stack invokes it once at boot as a one-shot service:
//   node dist/scripts/migrate.js
// Exits 0 on success, 1 on any failure (so `depends_on: service_completed_successfully`
// gates the backend / sync containers correctly).

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

  // Migrations live at `<backend>/drizzle/` in both source (src/scripts → ../../drizzle)
  // and built (dist/scripts → ../../drizzle) layouts, so the same relative resolve
  // works in dev (`tsx`) and in the production image where the Dockerfile copies
  // the drizzle/ directory alongside dist/.
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
