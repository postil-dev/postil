import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

import { requireEnv } from "@/lib/env";
import { redactSecrets } from "@/lib/redact";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let database: Database | undefined;

const DATABASE_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_POOL_MAX = 10;

/**
 * Lazy singleton so `next build` never needs a live database. The first
 * runtime call requires DATABASE_URL and fails with an actionable message
 * if it is absent.
 */
export function getDb(): Database {
  if (!database) {
    const connectionString = requireEnv("DATABASE_URL");
    try {
      // pg defers parsing the connection string to first connect, so a
      // malformed DATABASE_URL surfaces later as an error whose message embeds
      // the raw string (credentials included) - a boot-time credential leak in
      // platform logs. Parse eagerly here so a malformed URL fails at
      // construction, and redact the connection string out of any error
      // (including the parser's own, which echoes the offending URL) before it
      // escapes. Never log the URL itself.
      parseConnectionString(connectionString);
      pool = new Pool({
        connectionString,
        max: positiveIntEnv("POSTIL_DB_POOL_MAX", DEFAULT_POOL_MAX),
        connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
      });
    } catch (err) {
      throw new Error(
        `failed to construct database pool from DATABASE_URL: ${redactSecrets(err, [connectionString])}`,
      );
    }
    database = drizzle(pool, { schema });
  }
  return database;
}

export function getPool(): Pool {
  getDb();
  if (!pool) throw new Error("database pool not initialized");
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}

export { schema };

function positiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(`${name} must be a positive integer; using ${fallback}`);
  return fallback;
}
