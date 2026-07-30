"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  findDeviceAuthorizationByUserCode,
  normalizeUserCodeInput,
  type DeviceAuthorizationRow,
} from "@/lib/cli-auth";
import { getDb, schema, type Database } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

async function requirePendingDeviceAuthorization(
  db: Database,
  formData: FormData,
): Promise<{ code: string; row: DeviceAuthorizationRow }> {
  const code = normalizeUserCodeInput(String(formData.get("code") ?? ""));
  const row = await findDeviceAuthorizationByUserCode(db, code);
  if (!row || row.status !== "pending" || row.expiresAt <= new Date()) {
    throw new Error("this login code is no longer pending");
  }
  return { code, row };
}

/** Approve a device authorization for one organization the caller administers. */
export async function approveDeviceAuthorizationAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) throw new Error("not signed in");
  const db = getDb();
  const { code, row } = await requirePendingDeviceAuthorization(db, formData);

  const orgSlug = String(formData.get("orgSlug") ?? "");
  const membership = (
    await db
      .select({ orgId: schema.orgMembers.orgId })
      .from(schema.orgMembers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgMembers.orgId))
      .where(
        and(
          eq(schema.orgMembers.userId, user.id),
          eq(schema.orgMembers.role, "admin"),
          eq(schema.organizations.slug, orgSlug),
        ),
      )
      .limit(1)
  )[0];
  if (!membership) throw new Error("choose an organization you administer");

  const approved = await approveDeviceAuthorization(db, {
    id: row.id,
    userId: user.id,
    orgId: membership.orgId,
  });
  if (!approved) throw new Error("this login code is no longer pending");
  redirect(`/cli/authorize?code=${encodeURIComponent(code)}&result=approved`);
}

/** Deny a device authorization. The CLI's poll then reports denial and stops. */
export async function denyDeviceAuthorizationAction(formData: FormData): Promise<void> {
  const user = await getSessionUser();
  if (!user) throw new Error("not signed in");
  const db = getDb();
  const { code, row } = await requirePendingDeviceAuthorization(db, formData);

  const denied = await denyDeviceAuthorization(db, { id: row.id });
  if (!denied) throw new Error("this login code is no longer pending");
  redirect(`/cli/authorize?code=${encodeURIComponent(code)}&result=denied`);
}
