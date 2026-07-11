import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { lintMigrationSources, type MigrationSource } from "@/lib/migration-lint";

const LEGACY_UNSAFE_INDEXES = [
  "drizzle/0001_org_indexes_and_constraints.sql:1",
  "drizzle/0001_org_indexes_and_constraints.sql:2",
  "drizzle/0001_org_indexes_and_constraints.sql:45",
  "drizzle/0004_public_review_ids_and_logs.sql:15",
];

describe("migration lint", () => {
  test("rejects non-concurrent indexes on existing tables", () => {
    const findings = lintMigrationSources([
      {
        path: "drizzle/0001_create_widgets.sql",
        sql: 'CREATE TABLE "widgets" ("id" bigint PRIMARY KEY);',
      },
      {
        path: "drizzle/0002_add_widget_name_idx.sql",
        sql: 'CREATE INDEX "widgets_name_idx" ON "widgets" USING btree ("name");',
      },
    ]);

    expect(findings).toEqual([
      {
        path: "drizzle/0002_add_widget_name_idx.sql",
        line: 1,
        table: "widgets",
        statement: 'CREATE INDEX "widgets_name_idx" ON "widgets" USING btree ("name");',
        message: 'CREATE INDEX on existing table "widgets" must use CREATE INDEX CONCURRENTLY',
      },
    ]);
  });

  test("rejects schema-qualified non-concurrent indexes on existing tables", () => {
    const findings = lintMigrationSources([
      {
        path: "drizzle/0001_create_widgets.sql",
        sql: 'CREATE TABLE "public"."widgets" ("id" bigint PRIMARY KEY);',
      },
      {
        path: "drizzle/0002_add_widget_name_idx.sql",
        sql: 'CREATE INDEX "public"."widgets_name_idx" ON "public"."widgets" USING btree ("name");',
      },
      {
        path: "drizzle/0003_add_widget_slug_idx.sql",
        sql: 'CREATE UNIQUE INDEX IF NOT EXISTS public.widgets_slug_idx ON public.widgets ("slug");',
      },
    ]);

    expect(findings).toEqual([
      {
        path: "drizzle/0002_add_widget_name_idx.sql",
        line: 1,
        table: "public.widgets",
        statement: 'CREATE INDEX "public"."widgets_name_idx" ON "public"."widgets" USING btree ("name");',
        message: 'CREATE INDEX on existing table "public.widgets" must use CREATE INDEX CONCURRENTLY',
      },
      {
        path: "drizzle/0003_add_widget_slug_idx.sql",
        line: 1,
        table: "public.widgets",
        statement: 'CREATE UNIQUE INDEX IF NOT EXISTS public.widgets_slug_idx ON public.widgets ("slug");',
        message: 'CREATE INDEX on existing table "public.widgets" must use CREATE INDEX CONCURRENTLY',
      },
    ]);
  });

  test("accepts concurrent indexes on existing tables", () => {
    const findings = lintMigrationSources([
      {
        path: "drizzle/0001_create_widgets.sql",
        sql: 'CREATE TABLE "widgets" ("id" bigint PRIMARY KEY);',
      },
      {
        path: "drizzle/0002_add_widget_name_idx.sql",
        sql: 'CREATE INDEX CONCURRENTLY "widgets_name_idx" ON "widgets" USING btree ("name");',
      },
      {
        path: "drizzle/0003_add_widget_slug_idx.sql",
        sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "widgets_slug_idx" ON "widgets" ("slug");',
      },
      {
        path: "drizzle/0004_add_widget_status_idx.sql",
        sql: 'CREATE INDEX CONCURRENTLY "public"."widgets_status_idx" ON "public"."widgets" ("status");',
      },
    ]);

    expect(findings).toEqual([]);
  });

  test("accepts non-concurrent indexes on tables created in the same migration", () => {
    const findings = lintMigrationSources([
      {
        path: "drizzle/0001_create_widgets.sql",
        sql: `
          CREATE TABLE "widgets" ("id" bigint PRIMARY KEY, "name" text);
          CREATE INDEX "widgets_name_idx" ON "widgets" USING btree ("name");
        `,
      },
    ]);

    expect(findings).toEqual([]);
  });

  test("ignores comments and function bodies while scanning", () => {
    const findings = lintMigrationSources([
      {
        path: "drizzle/0001_create_widgets.sql",
        sql: 'CREATE TABLE "widgets" ("id" bigint PRIMARY KEY);',
      },
      {
        path: "drizzle/0002_commentary.sql",
        sql: `
          -- CREATE INDEX "widgets_name_idx" ON "widgets" ("name");
          DO $$
          BEGIN
            RAISE NOTICE 'CREATE INDEX widgets_name_idx ON widgets (name)';
          END $$;
          CREATE INDEX CONCURRENTLY "widgets_name_idx" ON "widgets" ("name");
        `,
      },
    ]);

    expect(findings).toEqual([]);
  });

  test("validates checked-in migrations", async () => {
    const migrations = await readDrizzleMigrations();

    expect(
      lintMigrationSources(migrations, {
        allowedUnsafeIndexes: LEGACY_UNSAFE_INDEXES,
      }),
    ).toEqual([]);
  });
});

async function readDrizzleMigrations(): Promise<MigrationSource[]> {
  const dir = join(import.meta.dir, "..", "drizzle");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();

  return Promise.all(
    files.map(async (file) => ({
      path: `drizzle/${file}`,
      sql: await readFile(join(dir, file), "utf8"),
    })),
  );
}
