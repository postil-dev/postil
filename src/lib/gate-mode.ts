import { eq, sql } from "drizzle-orm";

import { schema, type Database } from "@/lib/db";

/** Missing settings mean advisory mode for newly created organizations. */
export async function getOrganizationGateEnabled(
  db: Database,
  orgId: number | null,
): Promise<boolean> {
  if (orgId === null) return false;
  const row = (
    await db
      .select({ enabled: schema.orgSettings.gateEnabled })
      .from(schema.orgSettings)
      .where(eq(schema.orgSettings.orgId, orgId))
      .limit(1)
  )[0];
  return row?.enabled ?? false;
}

export async function lockOrganizationGateMode(
  db: Database,
  orgId: number,
): Promise<boolean> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`postil:gate-mode:${orgId}`}, 0))`,
  );
  return getOrganizationGateEnabled(db, orgId);
}

export async function getInstallationGateEnabled(
  db: Database,
  githubInstallationId: number,
): Promise<boolean> {
  const row = (
    await db
      .select({ orgId: schema.installations.orgId })
      .from(schema.installations)
      .where(eq(schema.installations.githubInstallationId, githubInstallationId))
  )[0];
  return getOrganizationGateEnabled(db, row?.orgId ?? null);
}
