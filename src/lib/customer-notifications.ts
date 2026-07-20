import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export const CUSTOMER_NOTIFICATION_RETENTION_DAYS = 180;
export const CUSTOMER_NOTIFICATION_RETENTION_MS =
  CUSTOMER_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const CUSTOMER_NOTIFICATION_PRUNE_BATCH_SIZE = 500;

export type CustomerNotificationSeverity = "info" | "warning" | "critical";
export type CustomerNotificationCategory =
  | "trial"
  | "billing"
  | "service"
  | "security";
export type CustomerNotificationVisibility = "members" | "admins";

export interface CustomerNotificationInput {
  orgId: number;
  orgSlug: string;
  idempotencyKey: string;
  severity: CustomerNotificationSeverity;
  category: CustomerNotificationCategory;
  title: string;
  body: string;
  visibility: CustomerNotificationVisibility;
  actionLabel?: string;
  actionHref?: string;
}

export function trialStartedNotification(input: {
  orgId: number;
  orgSlug: string;
  githubOwnerId: number;
}): CustomerNotificationInput {
  return {
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    idempotencyKey: `trial-started:${input.githubOwnerId}`,
    severity: "info",
    category: "trial",
    title: "Your 30-day trial is active",
    body: "Postil can review enabled repositories during your trial.",
    visibility: "members",
    actionLabel: "Open dashboard",
    actionHref: `/orgs/${encodeURIComponent(input.orgSlug)}`,
  };
}

export function trialExpiredNotification(input: {
  orgId: number;
  orgSlug: string;
  trialEndsAt: Date;
}): CustomerNotificationInput {
  return {
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    idempotencyKey: `trial-expired:${input.orgId}:${input.trialEndsAt.toISOString()}`,
    severity: "warning",
    category: "trial",
    title: "Your trial has ended",
    body: "Private-repository reviews are paused. An organization admin can choose a plan.",
    visibility: "members",
  };
}

export function subscriptionPastDueNotification(input: {
  orgId: number;
  orgSlug: string;
  providerSubscriptionId: string;
  eventId: string;
}): CustomerNotificationInput {
  return {
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    idempotencyKey: `subscription-past-due:${input.providerSubscriptionId}:${input.eventId}`,
    severity: "critical",
    category: "billing",
    title: "Payment needs attention",
    body: "Update billing details to keep private-repository reviews active.",
    visibility: "admins",
    actionLabel: "Open billing",
    actionHref: `/orgs/${encodeURIComponent(input.orgSlug)}/billing`,
  };
}

export function settlementFailedNotification(input: {
  orgId: number;
  orgSlug: string;
  settlementId: string;
}): CustomerNotificationInput {
  return {
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    idempotencyKey: `billing-settlement-failed:${input.settlementId}`,
    severity: "critical",
    category: "billing",
    title: "Payment could not be completed",
    body: "Review billing details to keep private-repository reviews active.",
    visibility: "admins",
    actionLabel: "Open billing",
    actionHref: `/orgs/${encodeURIComponent(input.orgSlug)}/billing`,
  };
}

type NotificationWriter = Pick<Database, "insert">;

/** Store one bounded customer message without coupling it to email delivery. */
export async function enqueueCustomerNotification(
  db: NotificationWriter,
  input: CustomerNotificationInput,
  now = new Date(),
): Promise<boolean> {
  const normalized = validateCustomerNotification(input);
  const { orgSlug: _orgSlug, ...stored } = normalized;
  const created = await db
    .insert(schema.customerNotificationEvents)
    .values({
      ...stored,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CUSTOMER_NOTIFICATION_RETENTION_MS),
    })
    .onConflictDoNothing({
      target: [
        schema.customerNotificationEvents.orgId,
        schema.customerNotificationEvents.idempotencyKey,
      ],
    })
    .returning({ id: schema.customerNotificationEvents.id });
  return created.length === 1;
}

export function validateCustomerNotification(
  input: CustomerNotificationInput,
): CustomerNotificationInput {
  if (!Number.isSafeInteger(input.orgId) || input.orgId < 1) {
    throw new Error("customer notification organization is invalid");
  }
  const idempotencyKey = boundedText(input.idempotencyKey, 200, "idempotency key");
  const orgSlug = boundedText(input.orgSlug, 100, "organization slug");
  const title = boundedText(input.title, 120, "title");
  const body = boundedText(input.body, 500, "body");
  const hasActionLabel = input.actionLabel !== undefined;
  const hasActionHref = input.actionHref !== undefined;
  if (hasActionLabel !== hasActionHref) {
    throw new Error("customer notification action label and link must be provided together");
  }
  const actionLabel = hasActionLabel
    ? boundedText(input.actionLabel!, 60, "action label")
    : undefined;
  const actionHref = hasActionHref ? input.actionHref!.trim() : undefined;
  if (actionHref) {
    const parsed = new URL(actionHref, "https://postil.invalid");
    const expectedPath = `/orgs/${encodeURIComponent(orgSlug)}`;
    if (
      !(parsed.pathname === expectedPath || parsed.pathname.startsWith(`${expectedPath}/`)) ||
      actionHref.includes("#") ||
      parsed.origin !== "https://postil.invalid" ||
      !parsed.pathname.startsWith("/orgs/")
    ) {
      throw new Error("customer notification action must use an organization path");
    }
  }
  return {
    ...input,
    orgSlug,
    idempotencyKey,
    title,
    body,
    actionLabel,
    actionHref,
  };
}

/** Delete expired customer events in bounded batches. Read receipts cascade. */
export async function pruneExpiredCustomerNotifications(
  db: Pick<Database, "execute">,
  now = new Date(),
  limit = CUSTOMER_NOTIFICATION_PRUNE_BATCH_SIZE,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("customer notification prune limit must be in 1..10000");
  }
  const result = await db.execute(sql`
    WITH expired AS (
      SELECT id
      FROM customer_notification_events
      WHERE expires_at <= ${now}
      ORDER BY expires_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM customer_notification_events AS event
    USING expired
    WHERE event.id = expired.id
  `);
  return result.rowCount ?? 0;
}

function boundedText(value: string, max: number, name: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max) {
    throw new Error(`customer notification ${name} must be 1..${max} characters`);
  }
  return normalized;
}
