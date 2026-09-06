import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";

import {
  COMPATIBLE_MANAGED_RELEASE_PROTOCOL,
  type ManagedReleaseMigrationIdentity,
  prepareCompatibleManagedRelease,
  restoreAllManagedReleasePreparations,
  verifyCompatibleManagedRelease,
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
type VerifyCompatibleRelease = (
  environment: Environment,
) => Promise<void>;
type PrepareCompatibleRelease = (
  environment: Environment,
) => Promise<boolean>;

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
  verifyCompatibleRelease: VerifyCompatibleRelease = defaultVerifyCompatibleRelease,
  prepareCompatibleRelease: PrepareCompatibleRelease = defaultPrepareCompatibleRelease,
  signal?: AbortSignal,
): Promise<void> {
  const databaseEnvironment = releaseMigrationEnvironment(environment);
  const managedRelease = databaseEnvironment.POSTIL_MANAGED_RELEASE;
  if (managedRelease !== undefined && managedRelease !== "0" && managedRelease !== "1") {
    throw new Error("POSTIL_MANAGED_RELEASE must be 0 or 1");
  }
  const releaseSha = databaseEnvironment.POSTIL_RELEASE_SHA;
  if (managedRelease !== "1") {
    await runUnmanagedReleaseMigrations(
      databaseEnvironment,
      spawnCommand,
      signal,
    );
    return;
  }
  if (!releaseSha) {
    throw new Error("managed release requires a non-empty POSTIL_RELEASE_SHA");
  }

  requireCompatibleReleaseProtocol(databaseEnvironment);
  await verifyCompatibleRelease(databaseEnvironment);
  await runReleaseDatabaseCommand(
    ["bun", "run", "hosted:verify-provider"],
    "hosted provider preflight",
    databaseEnvironment,
    spawnCommand,
    signal,
  );
  await prepareCompatibleRelease(databaseEnvironment);
}

async function runUnmanagedReleaseMigrations(
  environment: Environment,
  spawnCommand: SpawnReleaseDatabaseCommand,
  signal?: AbortSignal,
): Promise<void> {
  for (const [command, label] of [
    [["bun", "run", "db:migrate"], "release database migration"],
    [["bun", "run", "operational:indexes"], "release operational indexes"],
    [["bun", "run", "notifications:quiesce"], "release notification quiescence"],
  ] as const) {
    await runReleaseDatabaseCommand(
      command,
      label,
      environment,
      spawnCommand,
      signal,
    );
  }
}

function requireCompatibleReleaseProtocol(environment: Environment): string {
  const protocol = environment.POSTIL_RELEASE_PROTOCOL;
  if (protocol !== COMPATIBLE_MANAGED_RELEASE_PROTOCOL) {
    throw new Error(
      `POSTIL_RELEASE_PROTOCOL must be ${COMPATIBLE_MANAGED_RELEASE_PROTOCOL}`,
    );
  }
  return protocol;
}

function compatibleSourceReleaseSha(environment: Environment): string {
  const releaseSha = environment.POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA;
  if (!releaseSha) {
    throw new Error(
      "POSTIL_COMPATIBLE_SOURCE_RELEASE_SHA must identify the verified live fleet",
    );
  }
  return releaseSha;
}

export function checkedInReleaseMigrations(): ManagedReleaseMigrationIdentity[] {
  return readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  }).map(({ folderMillis, hash }) => ({ folderMillis, hash }));
}

async function defaultVerifyCompatibleRelease(
  environment: Environment,
): Promise<void> {
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    await verifyCompatibleManagedRelease(
      pool,
      compatibleSourceReleaseSha(environment),
      environment.POSTIL_RELEASE_SHA!,
      requireCompatibleReleaseProtocol(environment),
      checkedInReleaseMigrations(),
    );
  } finally {
    await pool.end();
  }
}

async function defaultPrepareCompatibleRelease(
  environment: Environment,
): Promise<boolean> {
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    return await prepareCompatibleManagedRelease(
      pool,
      compatibleSourceReleaseSha(environment),
      environment.POSTIL_RELEASE_SHA!,
      requireCompatibleReleaseProtocol(environment),
      checkedInReleaseMigrations(),
    );
  } finally {
    await pool.end();
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

export async function pendingReleasePreparationTargets(
  environment: Environment = process.env,
): Promise<string[]> {
  const databaseEnvironment = releaseMigrationEnvironment(environment);
  const pool = new Pool({ connectionString: databaseEnvironment.DATABASE_URL });
  try {
    const schema = await releaseSchemaState(pool);
    if (!schema.hostedReady) return [];
    const roots = await pool.query<{ name: string }>(
      `SELECT name
         FROM deployment_capabilities
        WHERE name LIKE $1
          AND name LIKE '%:root'
        ORDER BY activated_at DESC, name DESC`,
      ["managed-release-preparation:%"],
    );
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const row of roots.rows) {
      const match = row.name.match(
        /^managed-release-preparation:([0-9a-f]{7,40}):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:root$/,
      );
      if (!match) {
        throw new Error("managed release preparation journal is malformed");
      }
      const releaseSha = match[1]!;
      if (!seen.has(releaseSha)) {
        seen.add(releaseSha);
        targets.push(releaseSha);
      }
    }
    return targets;
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
      `${label} termination could not be observed`,
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
  if (process.argv[2] === "--pending-releases") {
    const targets = await pendingReleasePreparationTargets();
    if (targets.length > 0) process.stdout.write(`${targets.join("\n")}\n`);
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
      defaultVerifyCompatibleRelease,
      defaultPrepareCompatibleRelease,
      controller.signal,
    );
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
