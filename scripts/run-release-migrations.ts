import { Pool } from "pg";

import {
  type ManagedReleaseCapabilitySnapshot,
  prepareManagedReleaseCapabilities,
  restoreAllManagedReleasePreparations,
  restoreManagedReleaseCapabilities,
} from "@/lib/release-job-rollout";
import { resolveDirectDatabaseUrl } from "./resolve-direct-database-url";

type Environment = Record<string, string | undefined>;
type MigrationProcess = {
  exited: Promise<number>;
  kill?: (signal?: number | NodeJS.Signals) => unknown;
};
type SpawnReleaseDatabaseCommand = (
  command: readonly string[],
  environment: Environment,
) => MigrationProcess;
type PrepareReleaseCapabilities = (
  environment: Environment,
) => Promise<ManagedReleaseCapabilitySnapshot | undefined>;
type RestoreReleaseCapabilities = (
  environment: Environment,
  snapshot: ManagedReleaseCapabilitySnapshot,
) => Promise<void>;

class ReleaseCommandStateUncertainError extends Error {
  override name = "ReleaseCommandStateUncertainError";
}

export function releaseMigrationEnvironment(environment: Environment): Environment {
  const { POSTIL_DIRECT_DATABASE_URL: directDatabaseUrl, ...migrationEnvironment } = environment;
  return {
    ...migrationEnvironment,
    DATABASE_URL: resolveDirectDatabaseUrl({
      databaseUrl: environment.DATABASE_URL ?? "",
      directDatabaseUrl,
    }),
  };
}

export async function runReleaseMigrations(
  environment: Environment = process.env,
  spawnCommand: SpawnReleaseDatabaseCommand = defaultSpawnReleaseDatabaseCommand,
  prepareCapabilities: PrepareReleaseCapabilities = defaultPrepareReleaseCapabilities,
  restoreCapabilities: RestoreReleaseCapabilities = defaultRestoreReleaseCapabilities,
  signal?: AbortSignal,
): Promise<void> {
  const databaseEnvironment = releaseMigrationEnvironment(environment);
  const snapshot = await prepareCapabilities(databaseEnvironment);
  try {
    await runReleaseDatabaseCommand(
      ["bun", "run", "db:migrate"],
      "release database migration",
      databaseEnvironment,
      spawnCommand,
      signal,
    );
    await runReleaseDatabaseCommand(
      ["bun", "run", "operational:indexes"],
      "release operational indexes",
      databaseEnvironment,
      spawnCommand,
      signal,
    );
    await runReleaseDatabaseCommand(
      ["bun", "run", "notifications:quiesce"],
      "release notification quiescence",
      databaseEnvironment,
      spawnCommand,
      signal,
    );
  } catch (error) {
    if (snapshot && !(error instanceof ReleaseCommandStateUncertainError)) {
      try {
        await restoreCapabilities(databaseEnvironment, snapshot);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "release database preparation and capability compensation failed",
        );
      }
    }
    throw error;
  }
}

async function releaseSchemaState(pool: Pool): Promise<{
  hostedReady: boolean;
  publicationLifecycleReady: boolean;
}> {
  const result = await pool.query<{
    hostedReady: boolean;
    publicationLifecycleReady: boolean;
  }>(
    `SELECT
       to_regclass('public.deployment_capabilities') IS NOT NULL AS "hostedReady",
       to_regclass('public.deployment_capabilities') IS NOT NULL
         AND to_regclass('public.jobs') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'reviews'
              AND column_name = 'publication_lifecycle_required_at'
         ) AS "publicationLifecycleReady"`,
  );
  return result.rows[0] ?? {
    hostedReady: false,
    publicationLifecycleReady: false,
  };
}

async function defaultPrepareReleaseCapabilities(
  environment: Environment,
): Promise<ManagedReleaseCapabilitySnapshot | undefined> {
  const releaseSha = environment.POSTIL_RELEASE_SHA?.trim();
  if (!releaseSha) return undefined;
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    const schema = await releaseSchemaState(pool);
    if (!schema.hostedReady) return undefined;
    return await prepareManagedReleaseCapabilities(
      pool,
      releaseSha,
      schema.publicationLifecycleReady,
    );
  } finally {
    await pool.end();
  }
}

async function defaultRestoreReleaseCapabilities(
  environment: Environment,
  snapshot: ManagedReleaseCapabilitySnapshot,
): Promise<void> {
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    await restoreManagedReleaseCapabilities(pool, snapshot);
  } finally {
    await pool.end();
  }
}

export async function compensateReleasePreparation(
  environment: Environment = process.env,
): Promise<boolean> {
  const releaseSha = environment.POSTIL_RELEASE_SHA?.trim();
  if (!releaseSha) {
    throw new Error("POSTIL_RELEASE_SHA is required for release compensation");
  }
  const databaseEnvironment = releaseMigrationEnvironment(environment);
  const pool = new Pool({ connectionString: databaseEnvironment.DATABASE_URL });
  try {
    const schema = await releaseSchemaState(pool);
    if (!schema.hostedReady) return false;
    return (await restoreAllManagedReleasePreparations(pool)) > 0;
  } finally {
    await pool.end();
  }
}

export async function releasePreparationCleared(
  environment: Environment = process.env,
): Promise<boolean> {
  const databaseEnvironment = releaseMigrationEnvironment(environment);
  const pool = new Pool({ connectionString: databaseEnvironment.DATABASE_URL });
  try {
    const schema = await releaseSchemaState(pool);
    if (!schema.publicationLifecycleReady) return false;
    const state = await pool.query<{ ready: boolean }>(
      `SELECT
         NOT EXISTS (
           SELECT 1 FROM deployment_capabilities WHERE name LIKE $1
         )
         AND EXISTS (
           SELECT 1 FROM deployment_capabilities WHERE name = $2
         )
         AND EXISTS (
           SELECT 1 FROM deployment_capabilities WHERE name = $3
         ) AS ready`,
      [
        "managed-release-preparation:%",
        "publication-lifecycle-fleet-active",
        "hosted-inference-fleet-active",
      ],
    );
    return state.rows[0]?.ready === true;
  } finally {
    await pool.end();
  }
}

async function runReleaseDatabaseCommand(
  command: readonly string[],
  label: string,
  environment: Environment,
  spawnCommand: SpawnReleaseDatabaseCommand,
  signal?: AbortSignal,
): Promise<void> {
  let process: MigrationProcess;
  try {
    process = spawnCommand(command, environment);
  } catch (cause) {
    throw new Error(`${label} could not start`, { cause });
  }

  let exitCode: number;
  let abortHandler: (() => void) | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  try {
    abortHandler = () => {
      if (interrupted) return;
      interrupted = true;
      process.kill?.("SIGTERM");
      forceKillTimer = setTimeout(() => process.kill?.("SIGKILL"), 10_000);
    };
    if (signal?.aborted) abortHandler();
    else signal?.addEventListener("abort", abortHandler, { once: true });
    exitCode = await process.exited;
  } catch (cause) {
    throw new ReleaseCommandStateUncertainError(
      `${label} termination could not be observed; durable compensation remains pending`,
      { cause },
    );
  } finally {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
  if (interrupted) throw new Error(`${label} interrupted`);
  if (exitCode !== 0) {
    throw new Error(`${label} failed with status ${exitCode}`);
  }
}

function defaultSpawnReleaseDatabaseCommand(
  command: readonly string[],
  environment: Environment,
): MigrationProcess {
  return Bun.spawn([...command], {
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

if (import.meta.main) {
  if (process.argv[2] === "--compensate") {
    const restored = await compensateReleasePreparation();
    console.log(
      `release preparation compensation: ${restored ? "restored" : "not pending"}`,
    );
    process.exit(0);
  }
  if (process.argv[2] === "--verify-clear") {
    if (!(await releasePreparationCleared())) {
      throw new Error("release preparation remains pending or fleet capabilities are dark");
    }
    console.log("release preparation state is clear and active");
    process.exit(0);
  }
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    controller.abort(new Error(`release database preparation received ${signal}`));
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    await runReleaseMigrations(
      process.env,
      defaultSpawnReleaseDatabaseCommand,
      defaultPrepareReleaseCapabilities,
      defaultRestoreReleaseCapabilities,
      controller.signal,
    );
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
