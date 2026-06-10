import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __postilPg: postgres.Sql | undefined;
}

function clientSingleton(): postgres.Sql {
  if (!globalThis.__postilPg) {
    globalThis.__postilPg = postgres(env().DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return globalThis.__postilPg;
}

export const sql = clientSingleton();
export const db = drizzle(sql, { schema });
export type DB = typeof db;
