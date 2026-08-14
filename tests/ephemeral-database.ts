import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, Pool } from "pg";

/**
 * Migration-replay suites used to share one long-lived database, each
 * tolerating whatever "already exists" codes it happened to need. That made
 * runs order-dependent: a suite that left rows behind, or that omitted a
 * tolerated code another suite's migrations required, turned green in
 * isolation and red next to a sibling. Each suite instead gets its own
 * database, created and migrated fresh in beforeAll and released in afterAll,
 * so no suite can observe another's schema or data regardless of run order.
 */

const TOLERATED_MIGRATION_REPLAY_CODES = new Set([
  "42P07", // duplicate_table
  "42710", // duplicate_object (enum/index/trigger)
  "42701", // duplicate_column
  "42723", // duplicate_function
]);

export interface EphemeralDatabase {
  pool: Pool;
  databaseName: string;
  /** Connection string for this database, for code paths (like `getDb()`'s
   * DATABASE_URL-keyed singleton) that build their own connection rather
   * than taking `pool` directly. */
  url: string;
  drop(): Promise<void>;
}

export async function createUnmigratedEphemeralDatabase(
  label: string,
  options: { forceDrop?: boolean; maxConnections?: number } = {},
): Promise<EphemeralDatabase> {
  const baseUrl = process.env.POSTIL_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("POSTIL_TEST_DATABASE_URL is not set");

  const databaseName = `postil_${label}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: baseUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    await admin.end().catch(() => undefined);
    throw error;
  }

  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  const pool = new Pool({
    connectionString: url.toString(),
    max: options.maxConnections,
  });

  return {
    pool,
    databaseName,
    url: url.toString(),
    async drop() {
      let cleanupError: unknown;
      try {
        await pool.end();
        await retainOrDropTestDatabase(admin, databaseName, {
          force: options.forceDrop,
        });
      } catch (error) {
        cleanupError = error;
      }
      try {
        await admin.end();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) throw cleanupError;
    },
  };
}

export async function retainOrDropTestDatabase(
  admin: Client,
  databaseName: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (process.env.POSTIL_TEST_KEEP_DATABASE === "1") {
    console.log(`test database retained: ${databaseName}`);
    return;
  }
  const force = options.force ? " WITH (FORCE)" : "";
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"${force}`);
}

/**
 * Creates a uniquely named database on the server addressed by
 * POSTIL_TEST_DATABASE_URL, replays the full drizzle migration chain onto
 * it, and returns a pool bound to it plus a drop() to tear it down. `label`
 * becomes part of the database name, so a leaked database (a crashed run
 * that skipped afterAll) is identifiable by which suite created it.
 */
export async function createEphemeralDatabase(label: string): Promise<EphemeralDatabase> {
  const database = await createUnmigratedEphemeralDatabase(label);

  const migration = new Client({ connectionString: database.url });
  try {
    await migration.connect();
    const directory = join(import.meta.dir, "..", "drizzle");
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const source = await readFile(join(directory, file), "utf8");
      for (const statement of source.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (!trimmed) continue;
        try {
          await migration.query(trimmed);
        } catch (err) {
          const code = (err as { code?: string }).code;
          // A fresh database should never collide with itself. This tolerance
          // is cheap insurance against a prior run of the same database name
          // (e.g. a crash that skipped drop()) rather than the expected path.
          if (!TOLERATED_MIGRATION_REPLAY_CODES.has(code ?? "")) throw err;
        }
      }
    }
    await migration.end();
  } catch (error) {
    await migration.end().catch(() => undefined);
    await database.drop().catch(() => undefined);
    throw error;
  }

  return database;
}
