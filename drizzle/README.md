# Migration safety rules

Fly applies this directory to the production database while the existing web
and worker machines keep serving traffic. Every migration must remain safe
under normal read and write load and compatible with the deployed application.

## Indexes on existing tables

`CREATE INDEX` and `CREATE UNIQUE INDEX` block writes to an existing table for
the duration of the build. The migration lint rejects those statements on an
existing table. An index created in the same migration as its table is exempt.

- Use `CREATE INDEX CONCURRENTLY` to avoid blocking writes to an existing live
  table.
- Drizzle's PostgreSQL migrator wraps pending migration statements in a
  transaction, where PostgreSQL rejects `CREATE INDEX CONCURRENTLY`.
- A change that adds an index to an existing table must include an idempotent,
  non-transactional release step and its verification. Do not place the
  concurrent statement in the ordinary Drizzle migration stream.
- If a concurrent build fails partway, it can leave an invalid index
  behind. The release step must detect and remove that invalid index before a
  retry and must record successful completion durably.

Run the focused policy check with `bun test tests/migration-lint.test.ts`.

The schema and Drizzle snapshot describe the final released database. The
`operational:indexes` release step installs indexes that cannot run inside the
transactional migration stream and records their verified state in
`release_steps`.

## Bulk UPDATE/DELETE dedup work

Row rewrites must not run as one unbounded statement against a live table:

- Put bounded, resumable backfill logic under `scripts/`.
- Commit between batches so each statement holds locks and generates WAL for
  a bounded number of rows.
- Add the script to `release:prepare` before code that depends on its result.
- Keep schema changes backward-compatible with the application serving during
  the release command.

## Applying migrations

Fly runs `bun run release:prepare` as the deployment `release_command`. That
command runs `bun run db:migrate` before the application machines update. A
non-zero exit aborts the deployment. The release machine receives the deployed
database connection settings and secrets.

## Already-applied migrations

Files in this directory are treated as an immutable, ordered history once
applied to production. Do not edit or renumber a migration that has
already run; ship a new migration to fix forward instead.
