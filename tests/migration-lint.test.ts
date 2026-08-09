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
  test("validates complete finding dismissal audit rows", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0048_woozy_tigra.sql"),
      "utf8",
    );
    expect(migration).toContain('NEW."reason_tag" IS NULL OR');
    expect(migration).toContain('"reason_tag" IS NOT NULL');
    expect(migration).toContain('"finding_confidence" IS NOT NULL');
    expect(migration).toContain('"finding_kind" IS NULL');
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "finding_approvals_dismissal_check"',
    );
    expect(migration).toContain("jsonb_set");
    expect(migration).toContain(
      "to_jsonb(\"repositories\".\"github_repo_id\")",
    );
    expect(migration).not.toContain(
      "to_jsonb(\"repositories\".\"github_repo_id\"::text)",
    );
    expect(migration).toContain(
      "jsonb_typeof(\"jobs\".\"payload\"->'githubRepoId') IS DISTINCT FROM 'number'",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION suppress_duplicate_active_review_job()",
    );
    expect(migration).toContain(
      "PERFORM pg_advisory_xact_lock",
    );
    expect(migration).toContain(
      "legacy active review repository identity could not be resolved",
    );
    expect(migration).toContain("NEW.payload := jsonb_set");
    expect(migration).toContain("to_jsonb(repository_identity::bigint)");
    expect(migration.indexOf("CREATE OR REPLACE FUNCTION suppress_duplicate_active_review_job()"))
      .toBeLessThan(migration.indexOf('UPDATE "jobs"\nSET "payload" = jsonb_set'));
    expect(migration).toContain(
      "jsonb_typeof(NEW.payload->'githubRepoId') = 'number'",
    );
    expect(migration).toContain(
      "jsonb_typeof(existing.payload->'githubRepoId') = 'number'",
    );
  });

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

  test("keeps new migration timestamps after all historical migrations", async () => {
    const journal = JSON.parse(
      await readFile(join(import.meta.dir, "..", "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };

    const historicalInversions = new Map([["0007_finding_approvals", 1783774995964]]);
    let latestTimestamp = 0;

    for (const [index, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(index);
      const historicalTimestamp = historicalInversions.get(entry.tag);
      if (historicalTimestamp !== undefined) {
        expect(entry.when).toBe(historicalTimestamp);
      } else {
        expect(entry.when, `${entry.tag} must sort after every preceding migration`).toBeGreaterThan(
          latestTimestamp,
        );
      }
      latestTimestamp = Math.max(latestTimestamp, entry.when);
    }
  });

  test("finding approvals migration enforces active uniqueness and non-empty rationale", async () => {
    const migration = await readFile(join(import.meta.dir, "..", "drizzle", "0007_finding_approvals.sql"), "utf8");

    expect(migration).toContain('CREATE TABLE "finding_approvals"');
    expect(migration).toContain('"source_comment_id" uuid');
    expect(migration).toContain('CONSTRAINT "finding_approvals_rationale_nonempty" CHECK');
    expect(migration).toContain('length(btrim("finding_approvals"."rationale")) > 0');
    expect(migration).toContain('CREATE UNIQUE INDEX "finding_approvals_active_idx"');
    expect(migration).toContain('"review_id","finding_id"');
    expect(migration).toContain('"revoked_at" IS NULL');
    expect(migration).not.toContain('UPDATE "reviews" SET "engine_gate_failing" = "gate_failing"');
  });

  test("review job dedupe migration serializes queued and running work", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0023_atomic_review_job_dedupe.sql"),
      "utf8",
    );

    expect(migration).toContain('CREATE FUNCTION "suppress_duplicate_active_review_job"');
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("\"payload\"->>'repoFullName'");
    expect(migration).toContain("\"payload\"->>'prNumber'");
    expect(migration).toContain("\"payload\"->>'headSha'");
    expect(migration).toContain("\"kind\" = 'review'");
    expect(migration).toContain("\"status\" IN ('queued', 'running')");
    expect(migration).toContain('CREATE TRIGGER "jobs_suppress_duplicate_active_review_trigger"');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF "kind", "payload", "status"');
    expect(migration).toContain("row_number() OVER");
    expect(migration).toContain("duplicate_position > 1");
    expect(migration).toContain("SET \"status\" = 'failed'");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
  });

  test("webhook cutover serializes durable source dedupe without blocking indexes", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0025_activate_durable_webhook_inbox.sql"),
      "utf8",
    );
    expect(migration).toContain('CREATE FUNCTION "suppress_duplicate_webhook_source_job"');
    expect(migration).toContain(
      '("payload" IS NULL) IS DISTINCT FROM ("completed_at" IS NOT NULL)',
    );
    expect(migration).toContain(
      "jsonb_build_object('deliveryId', \"delivery\".\"delivery_id\")",
    );
    expect(migration).toContain("\"job\".\"kind\" = 'webhook-dispatch'");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("NEW.\"payload\"->>'sourceDeliveryId'");
    expect(migration).toContain('CREATE TRIGGER "jobs_suppress_duplicate_webhook_source_trigger"');
    expect(migration).toContain('BEFORE INSERT ON "jobs"');
    expect(migration).not.toContain('BEFORE INSERT OR UPDATE OF "kind", "payload" ON "jobs"');
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
  });

  test("creates operational indexes outside the transactional migration stream", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0026_operational_indexes.sql"),
      "utf8",
    );
    const releaseScript = await readFile(
      join(import.meta.dir, "..", "scripts", "ensure-operational-indexes.ts"),
      "utf8",
    );
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(migration).toContain('CREATE TABLE "release_steps"');
    expect(migration).not.toContain("CREATE INDEX");
    expect(releaseScript).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "reviews_running_started_at_idx"',
    );
    expect(releaseScript).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_running_locked_at_idx"',
    );
    expect(releaseScript).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_completed_at_idx"',
    );
    expect(releaseScript).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "respond_deliveries_pr_identity_idx"',
    );
    expect(releaseScript).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "finding_approvals_github_comment_idx"',
    );
    expect(releaseScript).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "finding_approvals_github_delivery_idx"',
    );
    expect(releaseScript).toContain("!state.indisvalid || !state.indisready");
    expect(releaseScript).toContain("DROP INDEX CONCURRENTLY IF EXISTS");
    expect(releaseScript).toContain("pg_try_advisory_lock($1, $2)");
    expect(releaseScript).toContain("pg_advisory_unlock($1, $2)");
    expect(releaseScript).toContain(
      'CREATE TABLE IF NOT EXISTS "release_steps"',
    );
    expect(releaseScript).toContain("INSERT INTO release_steps");
    expect(packageJson.scripts["release:prepare"]).toContain("operational:indexes");
  });

  test("BYOK provider migration preserves legacy rows and constrains new fields", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0014_byok_provider_settings.sql"),
      "utf8",
    );

    expect(migration).toContain("DEFAULT 'openai-compatible' NOT NULL");
    expect(migration).toContain("'openai-compatible', 'anthropic'");
    expect(migration).toContain('"api_auth_header_ciphertext" bytea');
    expect(migration).toContain('"api_auth_value_ciphertext" bytea');
    expect(migration).toContain('("api_auth_header_ciphertext" IS NULL) =');
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
