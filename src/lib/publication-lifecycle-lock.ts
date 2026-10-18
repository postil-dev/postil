import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";

/**
 * Release preparation drains operations tracked by the v1 durable job and
 * lease protocol before migration 0059 activates this transaction-scoped key.
 * A distinct key prevents obsolete session locks from blocking the protocol.
 */
export const PUBLICATION_LIFECYCLE_LOCK =
  "postil:publication-lifecycle-release-v2";

/** Keep lifecycle work ahead of narrower review locks in the global order. */
export async function lockPublicationLifecycleShared(
  database: Database,
): Promise<void> {
  await database.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${PUBLICATION_LIFECYCLE_LOCK}, 0))`,
  );
}
