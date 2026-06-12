import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { requireEnv } from "@/lib/env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let database: Database | undefined;

/**
 * Lazy singleton so `next build` never needs a live database. The first
 * runtime call requires DATABASE_URL and fails with an actionable message
 * if it is absent.
 */
export function getDb(): Database {
  if (!database) {
    pool = new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 10 });
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
