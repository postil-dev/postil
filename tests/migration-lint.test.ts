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
  test("adds a non-destructive comment identity fence beside lifecycle idempotency", async () => {
    const migration = await readFile(
      join(
        import.meta.dir,
        "..",
        "drizzle",
        "0052_finding_lifecycle_observations.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "finding_lifecycle_observations_delivery_comment_idx"',
    );
    expect(migration).toContain(
      'CREATE FUNCTION "postil_guard_finding_publication_comment_identity"',
    );
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain(
      'CREATE TRIGGER "finding_publications_guard_comment_identity"',
    );
    expect(migration).not.toMatch(/\bUPDATE\s+"finding_publications"\s+SET/u);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+"finding_publications"/u);
  });

  test("keeps the active Drizzle snapshot lineage cumulative", async () => {
    const snapshots = await Promise.all(
      ["0048", "0049", "0050", "0051", "0052", "0053", "0054"].map(async (index) =>
        JSON.parse(
          await readFile(
            join(import.meta.dir, "..", "drizzle", "meta", `${index}_snapshot.json`),
            "utf8",
          ),
        ) as {
          id: string;
          prevId: string;
          tables: Record<string, {
            columns?: Record<string, unknown>;
            checkConstraints?: Record<string, { value?: string }>;
          }>;
        }
      ),
    );
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]!.prevId).toBe(snapshots[index - 1]!.id);
    }
    const latest = snapshots.at(-1)!;
    expect(latest.tables["public.users"]?.columns).toMatchObject({
      membership_checked_at: expect.any(Object),
      membership_refresh_generation: expect.any(Object),
      membership_refresh_lease_until: expect.any(Object),
      membership_refresh_retry_after: expect.any(Object),
    });
    expect(
      latest.tables["public.reviews"]?.checkConstraints
        ?.reviews_trigger_source_check?.value,
    ).toContain("finding_reconciliation");
    expect(
      latest.tables["public.finding_lifecycle_observations"]?.columns,
    ).toMatchObject({
      source_delivery_id: expect.any(Object),
      review_id: expect.any(Object),
      finding_id: expect.any(Object),
      github_comment_id: expect.any(Object),
      resolver_github_id: expect.any(Object),
      resolver_login: expect.any(Object),
      resolution_authorized: expect.any(Object),
      forge_observed_at: expect.any(Object),
    });
    expect(
      latest.tables["public.finding_lifecycle_observations"]?.checkConstraints
        ?.finding_lifecycle_observations_resolver_check?.value,
    ).toContain("resolution_authorized");
    expect(
      latest.tables["public.finding_publications"]?.checkConstraints
        ?.finding_publications_initial_state_check?.value,
    ).toContain("fileComment");
    expect(
      latest.tables["public.finding_publications"]?.checkConstraints
        ?.finding_publications_file_comment_identity_check?.value,
    ).toContain("github_comment_id");
    expect(
      latest.tables["public.finding_publications"]?.checkConstraints
        ?.finding_publications_file_comment_identity_check?.value,
    ).toContain("current_state");
    const creationMigration = await readFile(
      join(
        import.meta.dir,
        "..",
        "drizzle",
        "0052_finding_lifecycle_observations.sql",
      ),
      "utf8",
    );
    const ownershipMigration = await readFile(
      join(
        import.meta.dir,
        "..",
        "drizzle",
        "0053_own_finding_lifecycle_observations.sql",
      ),
      "utf8",
    );
    expect(ownershipMigration).toContain(
      'REFERENCES "public"."reviews"("id") ON DELETE cascade',
    );
    expect(creationMigration).toContain('"review_id" bigint NOT NULL');
    expect(ownershipMigration).not.toContain("ADD COLUMN");
    expect(ownershipMigration).not.toMatch(/\bUPDATE\s+"finding_lifecycle_observations"/u);

    const fileCommentMigration = await readFile(
      join(
        import.meta.dir,
        "..",
        "drizzle",
        "0054_thick_scarlet_witch.sql",
      ),
      "utf8",
    );
    expect(fileCommentMigration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(fileCommentMigration).toContain(
      '"finding_publications_file_comment_identity_check"',
    );
    expect(ownershipMigration).not.toMatch(/\bDELETE\s+FROM\s+"finding_lifecycle_observations"/u);
    expect(ownershipMigration).not.toContain("finding_publications");
    expect(ownershipMigration).not.toContain("ALTER COLUMN");
    expect(ownershipMigration).not.toContain("CREATE INDEX");
  });

  test("uses a generation fence for rolling membership writers", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0048_new_jubilee.sql"),
      "utf8",
    );
    const authority = await readFile(
      join(import.meta.dir, "..", "src", "lib", "membership-authority.ts"),
      "utf8",
    );
    const session = await readFile(
      join(import.meta.dir, "..", "src", "lib", "session.ts"),
      "utf8",
    );

    expect(migration).toContain(
      "current_setting('postil.membership_writer', true) = 'generation-fenced'",
    );
    expect(migration).toContain("IF TG_OP = 'INSERT' THEN");
    expect(migration).toContain("ELSIF TG_OP = 'UPDATE' THEN");
    expect(migration).toContain("ELSIF TG_OP = 'DELETE' THEN");
    expect(migration).toContain(
      'CREATE TRIGGER "org_members_guard_membership_generation"',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "sessions_guard_legacy_membership_freshness"',
    );
    expect(migration.match(/\bFOR SHARE\b/g)).toHaveLength(2);
    expect(migration).toContain(
      'WHERE "id" = ANY("affected_user_ids")\n     ORDER BY "id"\n       FOR SHARE',
    );
    expect(migration).not.toContain("invalidate_membership_freshness");
    expect(migration).not.toContain('UPDATE "users"');
    expect(migration).not.toContain('UPDATE "sessions"');

    const claimStart = authority.indexOf(
      "export async function claimUserMembershipRefresh",
    );
    const claimEnd = authority.indexOf(
      "export async function waitForUserMembershipRefresh",
      claimStart,
    );
    const claim = authority.slice(claimStart, claimEnd);
    expect(claim).toContain(".update(schema.users)");
    expect(claim).toContain("membershipRefreshGeneration:");

    const reconcileIndex = session.indexOf("await reconcileOrgMemberships(tx");
    const sessionsIndex = session.indexOf(".update(schema.sessions)", reconcileIndex);
    const freshnessIndex = session.indexOf(
      "await completeUserMembershipRefresh(",
      sessionsIndex,
    );
    expect(reconcileIndex).toBeGreaterThan(-1);
    expect(sessionsIndex).toBeGreaterThan(reconcileIndex);
    expect(freshnessIndex).toBeGreaterThan(sessionsIndex);
  });

  test("validates complete finding dismissal audit rows", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0048_woozy_tigra.sql"),
      "utf8",
    );
    expect(migration).toContain('NEW."reason_tag" IS NULL OR');
    expect(migration).toContain(
      'ADD COLUMN "verb" "finding_approval_verb" DEFAULT \'approve\' NOT NULL',
    );
    expect(migration).toContain('"reason_tag" IS NOT NULL');
    expect(migration).toContain('"finding_confidence" IS NOT NULL');
    expect(migration).toContain('"finding_kind" IS NULL');
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "finding_approvals_dismissal_check"',
    );
    expect(migration).toContain("jsonb_set");
    expect(migration).toContain('LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE');
    expect(migration).toContain(
      "to_jsonb(\"repositories\".\"github_repo_id\")",
    );
    expect(migration).toContain(
      '"repositories"."github_repo_id" IS NOT NULL',
    );
    expect(migration).not.toContain(
      "to_jsonb(\"repositories\".\"github_repo_id\"::text)",
    );
    expect(migration).toContain(
      "jsonb_typeof(\"jobs\".\"payload\"->'githubRepoId') = 'number'",
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
    expect(migration).toContain(
      "NEW.payload->>'githubRepoId' ~ '^[1-9][0-9]*$'",
    );
    expect(migration).toContain(") IS NOT TRUE",
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

  test("adds queue lease generations behind a rolling-deploy fence", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0050_queue_lock_generation.sql"),
      "utf8",
    );

    expect(migration).toContain(
      'ALTER TABLE "jobs" ADD COLUMN "lock_generation" bigint DEFAULT 0 NOT NULL;',
    );
    expect(migration).toContain("queue-lock-generation-v1");
    expect(migration).toContain("_postilLockGenerationFence");
    expect(migration).toContain("_postilLockGenerationRunAfter");
    expect(migration).toContain("_postilReleaseV1RunAfter");
    expect(migration).not.toContain('UPDATE "jobs"');
    expect(migration).not.toContain("CREATE INDEX");
  });

  test("bridges rollback queue claims after lock-generation activation", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0050_queue_lock_generation.sql"),
      "utf8",
    );
    const guardStart = migration.indexOf("IF TG_OP = 'UPDATE'");
    const guardEnd = migration.indexOf("\n  RETURN NEW;\nEND;", guardStart);
    const guard = migration.slice(guardStart, guardEnd);

    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(guard).toContain("AND OLD.\"status\" = 'queued'");
    expect(guard).toContain("AND NEW.\"status\" = 'running'");
    expect(guard).toContain(
      "hashtextextended('postil:queue-lock-generation-v1', 0)",
    );
    expect(guard).toContain(
      "WHERE \"name\" = 'queue-lock-generation-v1'",
    );
    expect(guard).toContain("IF NOT EXISTS");
    expect(guard).toContain("NEW.\"status\" := 'queued'");
    expect(guard).toContain("NEW.\"attempts\" := OLD.\"attempts\"");
    expect(guard).toContain("NEW.\"run_after\" := 'infinity'::timestamptz");
    expect(guard).toContain(
      "NEW.\"lock_generation\" IS NOT DISTINCT FROM OLD.\"lock_generation\"",
    );
    expect(guard).toContain(
      "NEW.\"lock_generation\" := OLD.\"lock_generation\" + 1",
    );
    expect(guard).toContain(
      "ELSIF NEW.\"lock_generation\" IS DISTINCT FROM OLD.\"lock_generation\" + 1",
    );
    expect(guard).toContain(
      "queued-to-running claim must advance lock_generation by one",
    );
    expect(guard).toContain("USING ERRCODE = 'check_violation'");
  });

  test("fences legacy review claims at the database boundary", async () => {
    const migration = await readFile(
      join(
        import.meta.dir,
        "..",
        "drizzle",
        "0056_publication_controller_queue_fence.sql",
      ),
      "utf8",
    );
    const claimStart = migration.indexOf(
      'AND OLD."status" = \'queued\'\n    AND NEW."status" = \'running\'',
    );
    const claim = migration.slice(claimStart);

    expect(migration.startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "stage_unactivated_release_job"()',
    );
    expect(migration).toContain("publication-controller-dark:%");
    expect(migration).toContain("publication-controller-release:%");
    expect(migration).toContain("_postilPublicationControllerFence");
    expect(migration).toContain("_postilPublicationControllerRunAfter");
    expect(migration).toContain(
      "hashtextextended('postil:publication-controller-release', 0)",
    );
    expect(claimStart).toBeGreaterThanOrEqual(0);
    expect(claim).toContain('IF NEW."kind" = \'review\' THEN');
    expect(claim).toContain('NEW."status" := \'queued\';');
    expect(claim).toContain("NEW.\"attempts\" := OLD.\"attempts\"");
    expect(claim).toContain("NEW.\"run_after\" := 'infinity'::timestamptz");
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
    const flyConfig = await readFile(
      join(import.meta.dir, "..", "fly.toml"),
      "utf8",
    );
    const managedProcess = await readFile(
      join(import.meta.dir, "..", "scripts", "start-managed-process.ts"),
      "utf8",
    );
    const ciWorkflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const selfHostedSources = [
      {
        name: "README",
        source: await readFile(join(import.meta.dir, "..", "README.md"), "utf8"),
        migrateCommand: "bun run db:migrate",
        operationalCommand: "bun run operational:indexes",
        activationCommand: "bun run queue:activate-lock-generation",
      },
      {
        name: "self-hosted guide",
        source: await readFile(
          join(import.meta.dir, "..", "src", "app", "docs", "self-hosted", "page.tsx"),
          "utf8",
        ),
        migrateCommand: "docker compose run --rm web bun run db:migrate",
        operationalCommand: "docker compose run --rm web bun run operational:indexes",
        activationCommand:
          "docker compose run --rm web bun run queue:activate-lock-generation",
      },
      {
        name: "self-hosted article",
        source: await readFile(
          join(
            import.meta.dir,
            "..",
            "src",
            "app",
            "blog",
            "self-hosted-ai-code-review",
            "page.tsx",
          ),
          "utf8",
        ),
        migrateCommand: "docker compose run --rm web bun run db:migrate",
        operationalCommand: "docker compose run --rm web bun run operational:indexes",
        activationCommand:
          "docker compose run --rm web bun run queue:activate-lock-generation",
      },
      {
        name: "Compose manifest",
        source: await readFile(
          join(import.meta.dir, "..", "docker-compose.yml"),
          "utf8",
        ),
        migrateCommand: "docker compose run --rm web bun run db:migrate",
        operationalCommand: "docker compose run --rm web bun run operational:indexes",
        activationCommand:
          "docker compose run --rm web bun run queue:activate-lock-generation",
      },
    ];

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
    expect(releaseScript).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "finding_lifecycle_observations_review_idx"',
    );
    expect(releaseScript).toContain(
      'definitionMd5: "c5a23c5efc99023a32001bfe7318c723"',
    );
    expect(releaseScript).toContain("predicateMd5: null");
    const lifecycleIndex = releaseScript.slice(
      releaseScript.indexOf('name: "finding_lifecycle_observations_review_idx"'),
      releaseScript.indexOf('name: "jobs_active_review_identity_idx"'),
    );
    expect(lifecycleIndex).toContain("unique: false");
    expect(lifecycleIndex).toContain("keyCount: 1");
    expect(releaseScript).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "jobs_active_review_identity_idx"',
    );
    expect(releaseScript).toContain("CASE WHEN");
    expect(releaseScript).toContain("9223372036854775807");
    expect(releaseScript).toContain("2147483647");
    const triggerDefinition = releaseScript.slice(
      releaseScript.indexOf("const ACTIVE_REVIEW_SERIALIZATION_SQL"),
      releaseScript.indexOf("interface IndexState"),
    );
    expect(triggerDefinition).toContain("pg_advisory_xact_lock");
    const triggerRollout = releaseScript.slice(
      releaseScript.indexOf("async function installValidatedActiveReviewIdentityTrigger"),
      releaseScript.indexOf("async function assertActiveReviewIdentities"),
    );
    expect(triggerRollout).toContain('client.query("BEGIN")');
    expect(triggerRollout).toContain(
      'client.query(\'LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE\')',
    );
    expect(triggerRollout).toContain(
      "client.query(SERIALIZED_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL)",
    );
    expect(triggerRollout.indexOf("assertActiveReviewIdentities(client)"))
      .toBeLessThan(triggerRollout.indexOf('client.query("COMMIT")'));
    expect(triggerRollout).toContain('client.query("ROLLBACK")');
    expect(releaseScript.indexOf("installValidatedActiveReviewIdentityTrigger(client)"))
      .toBeLessThan(releaseScript.indexOf("for (const index of OPERATIONAL_INDEXES)"));
    expect(releaseScript).toContain("!state.indisvalid || !state.indisready");
    expect(releaseScript).toContain("DROP INDEX CONCURRENTLY IF EXISTS");
    expect(releaseScript).toContain("pg_try_advisory_lock($1, $2)");
    expect(releaseScript).toContain("pg_advisory_unlock($1, $2)");
    expect(releaseScript).toContain(
      'CREATE TABLE IF NOT EXISTS "release_steps"',
    );
    expect(releaseScript).toContain("INSERT INTO release_steps");
    const releaseStep = releaseScript.match(
      /const RELEASE_STEP = "([^"]+)";/u,
    )?.[1];
    expect(releaseStep).toBe("operational-indexes-v5");
    expect(ciWorkflow).toContain(
      `release_steps WHERE name = '${releaseStep}'`,
    );
    const releasePrepare = packageJson.scripts["release:prepare"] ?? "";
    expect(releasePrepare).toContain("operational:indexes");
    expect(releasePrepare.indexOf("db:migrate:release")).toBeLessThan(
      releasePrepare.indexOf("operational:indexes"),
    );
    expect(flyConfig).toContain(
      'release_command = "bun scripts/start-managed-process.ts release"',
    );
    expect(managedProcess).toContain(
      'release: ["bun", "run", "release:prepare"]',
    );
    for (const contract of selfHostedSources) {
      const migrateCount = contract.source.split(contract.migrateCommand).length - 1;
      const operationalCount =
        contract.source.split(contract.operationalCommand).length - 1;
      const activationCount =
        contract.source.split(contract.activationCommand).length - 1;
      expect(migrateCount, `${contract.name} must document migrations`).toBeGreaterThan(0);
      expect(
        operationalCount,
        `${contract.name} must pair every migration command with operational indexes`,
      ).toBe(migrateCount);
      expect(
        activationCount,
        `${contract.name} must activate queue lock generation after every migration`,
      ).toBe(migrateCount);
      expect(contract.source.indexOf(contract.migrateCommand)).toBeLessThan(
        contract.source.indexOf(contract.operationalCommand),
      );
      expect(contract.source.indexOf(contract.operationalCommand)).toBeLessThan(
        contract.source.indexOf(contract.activationCommand),
      );
    }
    const stoppedWorkerBootSequence = [
      "docker compose up -d db",
      "docker compose run --rm web bun run db:migrate",
      "docker compose run --rm web bun run operational:indexes",
      "docker compose run --rm web bun run queue:activate-lock-generation",
      "docker compose up -d",
    ].join("\n");
    for (const contract of selfHostedSources.filter(
      ({ name }) => name !== "README",
    )) {
      expect(contract.source.replace(/^#\s*/gmu, "")).toContain(
        stoppedWorkerBootSequence,
      );
    }
    expect(selfHostedSources.find(({ name }) => name === "self-hosted guide")?.source)
      .toContain("docker compose stop web worker");
  });

  test("keeps active-review serialization until the unique index is ready", async () => {
    const releaseScript = await readFile(
      join(import.meta.dir, "..", "scripts", "ensure-operational-indexes.ts"),
      "utf8",
    );
    const ensureStart = releaseScript.indexOf(
      "export async function ensureOperationalIndexes",
    );
    const ensureEnd = releaseScript.indexOf(
      "async function installValidatedActiveReviewIdentityTrigger",
      ensureStart,
    );
    const ensureBody = releaseScript.slice(ensureStart, ensureEnd);
    expect(releaseScript).toContain("SERIALIZED_ACTIVE_REVIEW_IDENTITY_TRIGGER_SQL");
    expect(releaseScript).toContain("ACTIVE_REVIEW_SERIALIZATION_SQL");
    expect(releaseScript).toContain("pg_advisory_xact_lock");
    expect(ensureBody.indexOf("installValidatedActiveReviewIdentityTrigger"))
      .toBeLessThan(ensureBody.indexOf("for (const index of OPERATIONAL_INDEXES)"));
    expect(ensureBody.indexOf("for (const index of OPERATIONAL_INDEXES)"))
      .toBeLessThan(ensureBody.indexOf("installNonlockingActiveReviewIdentityTrigger"));
  });

  test("quiesces old queue consumers until the managed fleet is homogeneous", async () => {
    const migration = await readFile(
      join(import.meta.dir, "..", "drizzle", "0050_queue_lock_generation.sql"),
      "utf8",
    );
    const rollout = await readFile(
      join(import.meta.dir, "..", "src", "lib", "release-job-rollout.ts"),
      "utf8",
    );
    const activation = await readFile(
      join(import.meta.dir, "..", "scripts", "activate-release-jobs.ts"),
      "utf8",
    );
    const selfHostedActivation = await readFile(
      join(
        import.meta.dir,
        "..",
        "scripts",
        "activate-queue-lock-generation.ts",
      ),
      "utf8",
    );
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const deploy = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );

    expect(migration).toContain("queue-lock-generation-v1");
    expect(migration).toContain("_postilLockGenerationFence");
    expect(migration).toContain('CREATE SEQUENCE "review_input_arrival_sequence"');
    expect(migration).toContain("reviewInputSequence");
    const rolloutTrigger = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION "stage_unactivated_release_job"'),
      migration.indexOf('CREATE TRIGGER "jobs_stage_unactivated_release_trigger"'),
    );
    expect(rolloutTrigger).toContain('IF NEW."kind" = \'review\'');
    expect(rolloutTrigger).toContain(
      "to_jsonb(nextval('review_input_arrival_sequence')::text)",
    );
    expect(rolloutTrigger).toContain(
      "{_postilCoalescedReviewPayload,reviewInputSequence}",
    );
    expect(rolloutTrigger.indexOf("reviewInputSequence")).toBeLessThan(
      rolloutTrigger.indexOf("queue-lock-generation-v1"),
    );
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF "kind", "payload", "status", "run_after"',
    );
    const afterTrigger = migration.slice(
      migration.indexOf('CREATE TRIGGER "jobs_stage_unactivated_release_trigger"'),
    );
    expect(afterTrigger).not.toContain('UPDATE "jobs"');
    expect(rollout).toContain("quiesceQueueForLockGeneration");
    expect(rollout).toContain("activateQueueLockGeneration");
    expect(rollout).toContain("FOR UPDATE SKIP LOCKED");
    expect(rollout).toContain("LIMIT $1");
    expect(rollout).toContain("LIMIT $3");
    expect(rollout).toContain("LIMIT $4");
    expect(rollout).toContain("set_config('lock_timeout'");
    expect(rollout).toContain("backfillActiveReviewInputSequences");
    expect(rollout).toContain("_postilLockGenerationRunAfter");
    expect(rollout).toContain("_postilReleaseV1RunAfter");
    expect(rollout).toContain("prepareLegacyReleaseV1Schedules");
    expect(rollout).toContain("rerun activation to resume");
    expect(rollout).toContain("(job.payload->>$2)::timestamptz");
    expect(rollout).toContain("rerun quiesce to resume");
    expect(rollout).toContain("rerun activation to resume");
    expect(rollout).toContain("WHERE status = 'running'");
    expect(rollout).toContain("payload->>$1 = 'true'");
    expect(packageJson.scripts["release:prepare"]).toContain(
      "queue:quiesce-lock-generation",
    );
    expect(activation).toContain("await activateQueueLockGeneration(getPool())");
    expect(selfHostedActivation).toContain(
      "await activateQueueLockGeneration(getPool())",
    );
    expect(packageJson.scripts["queue:activate-lock-generation"]).toContain(
      "activate-queue-lock-generation.ts",
    );
    expect(deploy.indexOf("verify-managed-fleet.jq")).toBeLessThan(
      deploy.indexOf('bun run jobs:activate-release'),
    );
  });

  test("bounds lock acquisition in new hot-table migrations", async () => {
    for (const file of [
      "0048_new_jubilee.sql",
      "0049_workable_madame_web.sql",
      "0050_queue_lock_generation.sql",
      "0051_finding_reconciliation_trigger.sql",
      "0052_finding_lifecycle_observations.sql",
      "0053_own_finding_lifecycle_observations.sql",
      "0056_publication_controller_queue_fence.sql",
    ]) {
      const migration = await readFile(
        join(import.meta.dir, "..", "drizzle", file),
        "utf8",
      );
      expect(migration.startsWith("SET LOCAL lock_timeout = '5s';"))
        .toBe(true);
    }
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
