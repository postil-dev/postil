import { resolveDirectDatabaseUrl } from "./resolve-direct-database-url";

type Environment = Record<string, string | undefined>;
type MigrationProcess = { exited: Promise<number> };
type SpawnReleaseDatabaseCommand = (
  command: readonly string[],
  environment: Environment,
) => MigrationProcess;

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
): Promise<void> {
  const databaseEnvironment = releaseMigrationEnvironment(environment);
  await runReleaseDatabaseCommand(
    ["bun", "run", "hosted:deactivate-release"],
    "release database deactivation",
    databaseEnvironment,
    spawnCommand,
  );
  await runReleaseDatabaseCommand(
    ["bun", "run", "db:migrate"],
    "release database migration",
    databaseEnvironment,
    spawnCommand,
  );
}

async function runReleaseDatabaseCommand(
  command: readonly string[],
  label: string,
  environment: Environment,
  spawnCommand: SpawnReleaseDatabaseCommand,
): Promise<void> {
  let process: MigrationProcess;
  try {
    process = spawnCommand(command, environment);
  } catch (cause) {
    throw new Error(`${label} could not start`, { cause });
  }

  let exitCode: number;
  try {
    exitCode = await process.exited;
  } catch (cause) {
    throw new Error(`${label} status could not be observed`, { cause });
  }
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

if (import.meta.main) await runReleaseMigrations();
