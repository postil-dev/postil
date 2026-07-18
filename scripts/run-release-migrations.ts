import { resolveDirectDatabaseUrl } from "./resolve-direct-database-url";

type Environment = Record<string, string | undefined>;
type MigrationProcess = { exited: Promise<number> };
type SpawnMigration = (environment: Environment) => MigrationProcess;

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
  spawnMigration: SpawnMigration = defaultSpawnMigration,
): Promise<void> {
  let process: MigrationProcess;
  try {
    process = spawnMigration(releaseMigrationEnvironment(environment));
  } catch (cause) {
    throw new Error("release database migration could not start", { cause });
  }

  let exitCode: number;
  try {
    exitCode = await process.exited;
  } catch (cause) {
    throw new Error("release database migration status could not be observed", { cause });
  }
  if (exitCode !== 0) {
    throw new Error(`release database migration failed with status ${exitCode}`);
  }
}

function defaultSpawnMigration(environment: Environment): MigrationProcess {
  return Bun.spawn(["bun", "run", "db:migrate"], {
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

if (import.meta.main) await runReleaseMigrations();
