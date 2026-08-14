"use server";

import { revalidatePath } from "next/cache";

import { and, eq, gt, or, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { getOrgMembership } from "@/lib/org-access";
import { MembershipVerificationUnavailableError } from "@/lib/auth-navigation";

export async function markNotificationRead(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const eventId = parseEventId(formData.get("eventId"));
  const access = await requireMembership(slug);
  const now = new Date();
  const event = (
    await access.db
      .select({ id: schema.customerNotificationEvents.id })
      .from(schema.customerNotificationEvents)
      .where(
        and(
          eq(schema.customerNotificationEvents.id, eventId),
          eq(schema.customerNotificationEvents.orgId, access.orgId),
          gt(schema.customerNotificationEvents.expiresAt, now),
          visibleToRole(access.role),
        ),
      )
      .limit(1)
  )[0];
  if (!event) throw new Error("notification not found");

  await access.db
    .insert(schema.customerNotificationReads)
    .values({ eventId, userId: access.userId, readAt: now })
    .onConflictDoNothing({
      target: [
        schema.customerNotificationReads.eventId,
        schema.customerNotificationReads.userId,
      ],
    });
  revalidateNotificationPaths(slug);
}

export async function markAllNotificationsRead(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const access = await requireMembership(slug);
  const now = new Date();
  const visibility = access.role === "admin"
    ? sql`event.visibility IN ('members', 'admins')`
    : sql`event.visibility = 'members'`;
  await access.db.execute(sql`
    INSERT INTO customer_notification_reads (event_id, user_id, read_at)
    SELECT event.id, ${access.userId}, ${now}
    FROM customer_notification_events AS event
    WHERE event.org_id = ${access.orgId}
      AND event.expires_at > ${now}
      AND ${visibility}
    ON CONFLICT (event_id, user_id) DO NOTHING
  `);
  revalidateNotificationPaths(slug);
}

function visibleToRole(role: string) {
  return role === "admin"
    ? or(
        eq(schema.customerNotificationEvents.visibility, "members"),
        eq(schema.customerNotificationEvents.visibility, "admins"),
      )
    : eq(schema.customerNotificationEvents.visibility, "members");
}

async function requireMembership(slug: string): Promise<{
  db: Database;
  orgId: number;
  userId: number;
  role: string;
}> {
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (access.reason === "verification_unavailable") {
      throw new MembershipVerificationUnavailableError(access.retryAvailableAt);
    }
    if (access.reason === "unauthenticated") throw new Error("not signed in");
    throw new Error("organization not found");
  }
  return {
    db: access.db,
    orgId: access.org.id,
    userId: access.user.id,
    role: access.membership.role,
  };
}

function parseEventId(raw: FormDataEntryValue | null): number {
  const value = String(raw ?? "");
  if (!/^[1-9]\d*$/.test(value)) throw new Error("notification id is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("notification id is invalid");
  return parsed;
}

function revalidateNotificationPaths(slug: string): void {
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/notifications`);
}
