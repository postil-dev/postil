import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";

export const PUBLICATION_LIFECYCLE_LOCK =
  "postil:publication-lifecycle-release";

/** Keep lifecycle work ahead of narrower review locks in the global order. */
export async function lockPublicationLifecycleShared(
  database: Database,
): Promise<void> {
  await database.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${PUBLICATION_LIFECYCLE_LOCK}, 0))`,
  );
}
