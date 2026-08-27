import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import type { Database } from "@/lib/db";
import * as schema from "@/lib/db/schema";

function databaseClientError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/**
 * Run one transaction on a pinned client and discard that client whenever the
 * transaction fails. This keeps transaction-scoped locks on one backend and
 * prevents an unconfirmed rollback from returning a poisoned client to the
 * pool.
 */
export async function withPinnedDatabaseTransaction<T>(
  pool: Pool,
  label: string,
  operation: (db: Database, client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const clientDatabase = drizzle(client, { schema });
  let bodyError: unknown;
  let bodyFailed = false;
  let releaseError: Error | undefined;
  try {
    return await clientDatabase.transaction(async (transaction) => {
      try {
        return await operation(transaction as Database, client);
      } catch (error) {
        bodyFailed = true;
        bodyError = error;
        throw error;
      }
    });
  } catch (error) {
    if (bodyFailed && error === bodyError) throw error;
    releaseError = databaseClientError(error, `${label} transaction failed`);
    if (bodyFailed) {
      throw new AggregateError(
        [databaseClientError(bodyError, `${label} operation failed`), releaseError],
        `${label} operation and transaction cleanup failed`,
      );
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
