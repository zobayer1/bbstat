# Manual schema (Flyway-style)

Tool-agnostic, hand-readable SQL migrations mirroring what Drizzle generates under `apps/backend/drizzle/`. Use these when applying schema changes by hand — DBA review, ad-hoc psql sessions, production rollouts that go through Flyway/Liquibase, or restoring a fresh DB without involving Drizzle's migrator.

## Source of truth

The TypeScript schema in `apps/backend/src/db/schema.ts` is **the source of truth.** Drizzle generates SQL under `apps/backend/drizzle/<NNNN>_<random_name>.sql`; that's the file the application's migrator (`make db-migrate`) actually applies.

Files in this `schema/` directory are a curated mirror:

- Same SQL semantics as the Drizzle output, but with Drizzle's `--> statement-breakpoint` markers stripped and statements grouped into readable sections (enums → tables → foreign keys → indexes).
- Named in [Flyway versioned-migration style](https://documentation.red-gate.com/fd/migrations-184127470.html): `V<major>_<minor>__<short_description>.sql`, e.g. `V1_1__initial_schema.sql`.
- Suitable to feed into Flyway, Liquibase, or `psql -f` directly.

## Naming convention

```
V<major>_<minor>__<snake_case_description>.sql
```

- `V` prefix is required (Flyway convention; tools key off it).
- Use `_` to separate the version components (Flyway treats `_` and `.` as equivalent).
- **Two underscores** separate the version from the description.
- Description in lowercase `snake_case`, ≤ 6 words, focused on the change itself (`add_users_email`, `drop_legacy_audit_table`), not the date or ticket number.

Versions are monotonically increasing. When in doubt, increment the minor version (`V1_1` → `V1_2` → `V1_3`); reserve major bumps for substantial reshapes.

## Workflow when adding a migration

1. Edit `apps/backend/src/db/schema.ts`.
2. Run `make db-generate` — Drizzle writes `apps/backend/drizzle/<NNNN>_<random>.sql`.
3. Apply locally with `make db-migrate` to confirm it works.
4. **Mirror it here** — copy the new SQL into `apps/backend/schema/V<n>__<desc>.sql`, strip the `--> statement-breakpoint` markers, optionally regroup into the standard sections.
5. Commit both files in the same commit so they stay in lockstep.

If the two ever diverge, the Drizzle file under `drizzle/` wins — that's what the application actually runs.
