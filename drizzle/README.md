# Migration safety rules

This directory is applied against a live production database while web and
worker keep serving traffic. There is no maintenance window, so every
migration has to be safe to run concurrently with normal read/write load.

## Indexes on existing tables

`CREATE INDEX` (and `CREATE UNIQUE INDEX`) takes a table-level lock for the
duration of the build when run inside a transaction, which is how
drizzle-kit applies migrations by default. On a table with any real traffic
this blocks writes for as long as the build takes.

- Add new indexes with `CREATE INDEX CONCURRENTLY`, which does not hold a
  blocking lock but also cannot run inside a transaction.
- drizzle-kit wraps every migration file in a transaction unless you opt
  out. Use the no-transaction escape for the migration file (see
  drizzle-kit docs for `--custom` / the `sql.raw` + non-transactional
  migration pattern), or apply the `CREATE INDEX CONCURRENTLY` statement
  by hand and keep the migration file as a paired, checked-in record of
  what ran.
- If a concurrent build fails partway, it can leave an invalid index
  behind (`\d+ <table>` will show it as `INVALID` in psql). Drop it and
  retry rather than assuming the next migration run will fix it.

## Bulk UPDATE/DELETE dedup work

Row rewrites (backfills, dedup passes, data cleanup) should not run as one
unbounded statement against a live table:

- Batch the work (e.g. loop over a bounded id range or `LIMIT`/`OFFSET`
  chunks, committing between batches) so no single statement holds locks
  or generates WAL for more than a few thousand rows at a time.
- If batching isn't practical, run the migration in a quiet window
  (announce it, or schedule it for low-traffic hours) instead of at
  arbitrary deploy time.
- Prefer writing one-off dedup/backfill logic as a script under `scripts/`
  that can be re-run and observed, rather than folding it into a
  drizzle-kit migration file, unless it must be transactionally tied to a
  schema change.

## Applying migrations

Migrations are not run automatically on deploy. Apply them manually:

```
fly ssh console -C "bun run db:migrate"
```

Run this while `POSTIL_DB_POOL_MAX=2` (set in `fly.toml`) so the migration
connection doesn't compete with web/worker for the small production
connection pool.

## Already-applied migrations

Files in this directory are treated as an immutable, ordered history once
applied to production. Do not edit or renumber a migration that has
already run; ship a new migration to fix forward instead.
