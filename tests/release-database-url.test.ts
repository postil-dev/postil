import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDirectDatabaseUrl } from "../scripts/resolve-direct-database-url";
import {
  releaseMigrationEnvironment,
  runReleaseMigrations,
} from "../scripts/run-release-migrations";

describe("release database connection", () => {
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
    ).rejects.toThrow("release database migration status could not be observed");
  });

  test("restores the captured capability state when any database preparation step fails", async () => {
    const environment = {
      DATABASE_URL: "postgresql://postil@db.internal:5432/postil",
      POSTIL_RELEASE_SHA: "a".repeat(40),
    };
    const snapshot = {
      releaseSha: "a".repeat(40),
      publicationLifecycleReady: true,
      capabilities: [
        "publication-lifecycle-fleet-active",
        "hosted-inference-fleet-active",
      ],
    };
    const commands: string[][] = [];
    const restored: unknown[] = [];

    await expect(
      runReleaseMigrations(
        environment,
        (command) => {
          commands.push([...command]);
          return {
            exited: Promise.resolve(
              command.includes("operational:indexes") ? 17 : 0,
            ),
          };
        },
        async () => snapshot,
        async (_databaseEnvironment, captured) => {
          restored.push(captured);
        },
      ),
    ).rejects.toThrow("release operational indexes failed with status 17");
    expect(commands).toEqual([
      ["bun", "run", "db:migrate"],
      ["bun", "run", "operational:indexes"],
    ]);
    expect(restored).toEqual([snapshot]);
  });

  test("keeps the checked-in release and deploy contracts aligned", async () => {
    const root = join(import.meta.dir, "..");
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const deployWorkflow = await readFile(join(root, ".github", "workflows", "deploy.yml"), "utf8");
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
    expect(deployWorkflow).toContain('staged+="DATABASE_URL=${DATABASE_URL}"');
    expect(deployWorkflow).not.toContain("POSTIL_DIRECT_DATABASE_URL");
    expect(deactivationScript).toContain("resolveDirectDatabaseUrl");
    expect(deactivationScript).toContain("publication_lifecycle_required_at");
    expect(deactivationScript.indexOf("process.env.DATABASE_URL =")).toBeLessThan(
      deactivationScript.indexOf("getPool().query"),
    );
  });
});
