import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { resolveDirectDatabaseUrl } from "../scripts/resolve-direct-database-url";
import { releaseActivationMode } from "../scripts/activate-release-jobs";
import {
  releaseMigrationEnvironment,
  runReleaseMigrations,
} from "../scripts/run-release-migrations";

describe("release database connection", () => {
  test("defaults activation to read-only rolling verification", () => {
    expect(releaseActivationMode(undefined, { POSTIL_MANAGED_RELEASE: "1" })).toBe("rolling");
    expect(releaseActivationMode(undefined, {})).toBe("maintenance");
    expect(releaseActivationMode(undefined, { POSTIL_MANAGED_RELEASE: "0", POSTIL_RELEASE_SHA: "telemetry" })).toBe("maintenance");
    expect(releaseActivationMode("--rolling")).toBe("rolling");
    expect(releaseActivationMode("--maintenance")).toBe("maintenance");
    expect(() => releaseActivationMode("--unknown")).toThrow(
      "accepts only --rolling or --maintenance",
    );
  });

  test("derives the Supabase session-pool endpoint without exposing a separate secret", () => {
    const resolved = new URL(
      resolveDirectDatabaseUrl({
        databaseUrl:
          "postgresql://postgres.project@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require",
      }),
    );

    expect(resolved.port).toBe("5432");
    expect(resolved.searchParams.has("pgbouncer")).toBe(false);
    expect(resolved.searchParams.get("sslmode")).toBe("require");
  });

  test("prefers an explicit direct connection and rejects unknown transaction pools", () => {
    const direct = "postgresql://postil@db.internal:5432/postil";
    expect(
      resolveDirectDatabaseUrl({
        databaseUrl: "postgresql://postil@pooler.example.com:6543/postil",
        directDatabaseUrl: direct,
      }),
    ).toBe(new URL(direct).toString());
    expect(() =>
      resolveDirectDatabaseUrl({
        databaseUrl: "postgresql://postil@pooler.example.com:6543/postil",
      }),
    ).toThrow(/known session endpoint/);
    expect(() =>
      resolveDirectDatabaseUrl({
        databaseUrl: "postgresql://postil@db.internal:5432/postil",
        directDatabaseUrl: "   ",
      }),
    ).toThrow(/cannot be empty/);
  });

  test("binds the migration subprocess to the direct connection", async () => {
    const runtimeUrl =
      "postgresql://postgres.project@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    const directUrl =
      "postgresql://postgres.project@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
    const parentEnvironment = {
      DATABASE_URL: runtimeUrl,
      POSTIL_DIRECT_DATABASE_URL: directUrl,
      POSTIL_DB_POOL_MAX: "2",
    };
    let childEnvironment: Record<string, string | undefined> | undefined;
    const commands: Array<readonly string[]> = [];

    await runReleaseMigrations(parentEnvironment, (command, environment) => {
      commands.push(command);
      childEnvironment = environment;
      return { exited: Promise.resolve(0) };
    });

    expect(commands).toEqual([
      ["bun", "run", "db:migrate"],
      ["bun", "run", "operational:indexes"],
      ["bun", "run", "notifications:quiesce"],
    ]);
    expect(parentEnvironment.DATABASE_URL).toBe(runtimeUrl);
    expect(childEnvironment?.DATABASE_URL).toBe(new URL(directUrl).toString());
    expect(childEnvironment?.POSTIL_DIRECT_DATABASE_URL).toBeUndefined();
    expect(childEnvironment?.POSTIL_DB_POOL_MAX).toBe("2");
  });

  test("runs the checked-in migration child with the rewritten environment", async () => {
    const root = join(import.meta.dir, "..");
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "postil-release-migration-"));
    const fakeBun = join(temporaryDirectory, "bun");
    const capturePath = join(temporaryDirectory, "capture.json");
    const runtimeUrl =
      "postgresql://postgres.project@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require";

    try {
      await writeFile(
        fakeBun,
        `#!${process.execPath}\nconst path = process.env.POSTIL_TEST_CAPTURE_PATH; let entries = []; try { entries = JSON.parse(await Bun.file(path).text()); } catch {} entries.push({ arguments: process.argv.slice(2), databaseUrl: process.env.DATABASE_URL, hasDirectDatabaseUrl: "POSTIL_DIRECT_DATABASE_URL" in process.env }); await Bun.write(path, JSON.stringify(entries));\n`,
      );
      await chmod(fakeBun, 0o755);

      const wrapper = Bun.spawn(
        [process.execPath, "run", "scripts/run-release-migrations.ts"],
        {
          cwd: root,
          env: {
            ...process.env,
            DATABASE_URL: runtimeUrl,
            PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
            POSTIL_TEST_CAPTURE_PATH: capturePath,
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const exitCode = await wrapper.exited;
      const stderr = await new Response(wrapper.stderr).text();
      expect(exitCode, stderr).toBe(0);

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as Array<{
        arguments: string[];
        databaseUrl: string;
        hasDirectDatabaseUrl: boolean;
      }>;
      expect(capture.map((entry) => entry.arguments)).toEqual([
        ["run", "db:migrate"],
        ["run", "operational:indexes"],
        ["run", "notifications:quiesce"],
      ]);
      for (const entry of capture) {
        expect(new URL(entry.databaseUrl).port).toBe("5432");
        expect(new URL(entry.databaseUrl).searchParams.has("pgbouncer")).toBe(false);
        expect(entry.hasDirectDatabaseUrl).toBe(false);
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("adds release context to migration process failures", async () => {
    const environment = {
      DATABASE_URL: "postgresql://postil@db.internal:5432/postil",
    };
    await expect(
      runReleaseMigrations(environment, () => {
        throw new Error("spawn failed");
      }),
    ).rejects.toThrow("release database migration could not start");
    await expect(
      runReleaseMigrations(environment, () => ({ exited: Promise.reject(new Error("lost child")) })),
    ).rejects.toThrow("release database migration termination could not be observed");
  });

  test("rejects a managed release without its image SHA before spawning", async () => {
    let spawned = false;
    await expect(
      runReleaseMigrations(
        {
          DATABASE_URL: "postgresql://postil@db.internal:5432/postil",
          POSTIL_MANAGED_RELEASE: "1",
        },
        () => {
          spawned = true;
          return { exited: Promise.resolve(0) };
        },
      ),
    ).rejects.toThrow("managed release requires a non-empty POSTIL_RELEASE_SHA");
    await expect(
      runReleaseMigrations({
        DATABASE_URL: "postgresql://postil@db.internal:5432/postil",
        POSTIL_MANAGED_RELEASE: "true",
      }),
    ).rejects.toThrow("POSTIL_MANAGED_RELEASE must be 0 or 1");
    expect(spawned).toBe(false);
  });

  test("verifies compatibility, preflights the provider, then prepares additively", async () => {
    const environment = {
      POSTIL_MANAGED_RELEASE: "1",
      DATABASE_URL: "postgresql://postil@db.internal:5432/postil",
      POSTIL_RELEASE_SHA: "a".repeat(40),
      POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: "b".repeat(40),
      POSTIL_RELEASE_PROTOCOL: "additive-publication-hosted-v1",
    };
    const events: string[] = [];
    const commands: string[][] = [];

    await runReleaseMigrations(
      environment,
      (command) => {
        events.push("provider preflight");
        commands.push([...command]);
        return { exited: Promise.resolve(0) };
      },
      async () => {
        events.push("compatibility verified");
      },
      async () => {
        events.push("release prepared");
        return true;
      },
    );
    expect(commands).toEqual([["bun", "run", "hosted:verify-provider"]]);
    expect(events).toEqual([
      "compatibility verified",
      "provider preflight",
      "release prepared",
    ]);
  });

  test("rejects incompatibility and provider failure before preparation", async () => {
    const environment = {
      POSTIL_MANAGED_RELEASE: "1",
      DATABASE_URL: "postgresql://postil@db.internal:5432/postil",
      POSTIL_RELEASE_SHA: "c".repeat(40),
      POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA: "b".repeat(40),
      POSTIL_RELEASE_PROTOCOL: "additive-publication-hosted-v1",
    };
    let spawned = false;
    let prepared = false;
    await expect(
      runReleaseMigrations(
        environment,
        () => {
          spawned = true;
          return { exited: Promise.resolve(0) };
        },
        async () => {
          throw new Error("migration mismatch");
        },
        async () => {
          prepared = true;
          return true;
        },
      ),
    ).rejects.toThrow("migration mismatch");
    expect(spawned).toBe(false);
    expect(prepared).toBe(false);

    await expect(
      runReleaseMigrations(
        environment,
        () => ({ exited: Promise.resolve(23) }),
        async () => undefined,
        async () => {
          prepared = true;
          return true;
        },
      ),
    ).rejects.toThrow("hosted provider preflight failed with status 23");
    expect(prepared).toBe(false);
  });

  test("keeps the checked-in release and deploy contracts aligned", async () => {
    const root = join(import.meta.dir, "..");
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const deployWorkflow = await readFile(join(root, ".github", "workflows", "deploy.yml"), "utf8");
    const ciWorkflow = await readFile(
      join(root, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const productionMonitorWorkflow = await readFile(
      join(root, ".github", "workflows", "production-monitor.yml"),
      "utf8",
    );
    const deployWorkflowConfig = parse(deployWorkflow) as {
      concurrency: { group: string; queue: string; "cancel-in-progress": boolean };
    };
    const productionMonitorConfig = parse(productionMonitorWorkflow) as {
      concurrency: { group: string; queue: string; "cancel-in-progress": boolean };
      jobs: {
        "release-recovery": {
          concurrency: {
            group: string;
            queue: string;
            "cancel-in-progress": boolean;
          };
        };
      };
    };
    const deactivationScript = await readFile(
      join(root, "scripts", "deactivate-hosted-inference.ts"),
      "utf8",
    );

    expect(packageJson.scripts["release:prepare"]).toBe(
      "bun run db:migrate:release",
    );
    expect(packageJson.scripts["db:migrate:release"]).toBe(
      "bun run scripts/run-release-migrations.ts",
    );
    expect(deployWorkflow).toContain("Verify runtime secret contract");
    expect(deployWorkflow).not.toContain("flyctl secrets import");
    expect(deployWorkflow).not.toContain("flyctl secrets unset");
    expect(deployWorkflow).not.toContain("POSTIL_DIRECT_DATABASE_URL");
    expect(deployWorkflow).not.toContain(
      "Restore capabilities when release preparation failed before replacement",
    );
    expect(
      deployWorkflow.split("jq -ce -f scripts/verify-managed-fleet.jq").length - 1,
    ).toBeGreaterThanOrEqual(2);
    expect(deployWorkflow).not.toContain("bun scripts/run-release-migrations.ts --compensate");
    expect(deployWorkflow).toContain("POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA");
    expect(deployWorkflow).toContain("additive-publication-hosted-v1");
    expect(deployWorkflow).toContain("Verify compatible source fleet");
    expect(deployWorkflow).not.toContain("--skip-release-command");
    expect(deployWorkflow).toContain('flyctl machine update "${id}"');
    expect(deployWorkflow).toContain("bun run jobs:activate-release");
    expect(deployWorkflow).not.toContain("jobs:activate-release --maintenance");
    expect(ciWorkflow).toContain("bun run jobs:activate-release --maintenance");
    expect(productionMonitorWorkflow).toContain('workflows: ["deploy"]');
    expect(deployWorkflowConfig.concurrency).toEqual({
      group: "fly-deploy",
      queue: "max",
      "cancel-in-progress": false,
    });
    expect(productionMonitorConfig.concurrency.queue).toBe("max");
    expect(productionMonitorConfig.concurrency["cancel-in-progress"]).toBe(false);
    expect(productionMonitorConfig.concurrency.group).toContain(
      "production-monitor-deploy-{0}",
    );
    expect(productionMonitorConfig.concurrency.group).toContain(
      "github.event.workflow_run.id",
    );
    expect(
      productionMonitorConfig.jobs["release-recovery"].concurrency,
    ).toEqual({
      group: "fly-deploy",
      queue: "max",
      "cancel-in-progress": false,
    });
    expect(productionMonitorWorkflow).toContain(
      "bun scripts/run-release-migrations.ts --pending-releases",
    );
    expect(productionMonitorWorkflow).toContain(
      "A newer release preparation owns recovery.",
    );
    expect(productionMonitorWorkflow).not.toContain("latest_deploy_run_id");
    expect(productionMonitorWorkflow).toContain(
      "github.event_name != 'workflow_run'",
    );
    expect(productionMonitorWorkflow).toContain(
      "needs.release-recovery.outputs.clear == 'true'",
    );
    expect(productionMonitorWorkflow).toContain(
      "jq -ce -f scripts/verify-managed-fleet.jq",
    );
    expect(productionMonitorWorkflow).toContain(
      'recovery_target_sha="${recovery_targets[0]}"',
    );
    expect(productionMonitorWorkflow).toContain(
      "needs: [smoke, release-recovery]",
    );
    expect(productionMonitorWorkflow).toContain(
      "Postil release recovery failed",
    );
    expect(productionMonitorWorkflow).toContain("postil-release-recovery");
    expect(productionMonitorWorkflow).toContain(
      "needs.release-recovery.result == 'cancelled') && 'postil-release-recovery'",
    );
    expect(productionMonitorWorkflow).toContain(
      "needs.release-recovery.result == 'cancelled'",
    );
    expect(productionMonitorWorkflow).toContain(
      "bun scripts/run-release-migrations.ts --verify-clear",
    );
    expect(deactivationScript).toContain(
      "standalone release deactivation is unsupported",
    );
    expect(deactivationScript).not.toContain("prepareManagedReleaseCapabilities");
    expect(deactivationScript).not.toContain(
      "deactivateHostedInferenceRelease",
    );
    expect(deactivationScript).not.toContain(
      "deactivatePublicationLifecycleRelease",
    );
  });
});
