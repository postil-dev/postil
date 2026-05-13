import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

let _pool: Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getPool(): Pool {
  if (!_pool) {
    if (!env.databaseUrl) {
      throw new Error("NEON_CONNECTION_STRING or DATABASE_URL is not set");
    }
    _pool = new Pool({ connectionString: env.databaseUrl, max: 10 });
  }
  return _pool;
}

export function getDb() {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

export { schema };
