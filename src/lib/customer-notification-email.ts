import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { sanitizeVerificationLabel } from "@/lib/email-verification";
import {
  DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES,
  organizationEmailEnabled,
  type OrganizationEmailCategory,
} from "@/lib/organization-notification-preferences";
import { PermanentJobError } from "@/lib/queue";
import {
  sendTransactionalEmail,
  type TransactionalEmailContent,
} from "@/lib/transactional-email";

export const CUSTOMER_EMAIL_SUMMARY_DELAY_MS = 24 * 60 * 60 * 1_000;
export const CUSTOMER_EMAIL_BATCH_SIZE = 20;
/** Longer than the 10-second transport timeout and shorter than stale-job recovery. */
export const CUSTOMER_EMAIL_CLAIM_TIMEOUT_MS = 60 * 1_000;
const CUSTOMER_EMAIL_SCAN_LIMIT = 1_000;

export interface CustomerNotificationEmailJobPayload extends Record<string, unknown> {
  deliveryId: string;
}

interface CustomerNotificationEmailEvent {
  id: number;
  idempotencyKey: string;
  severity: string;
  title: string;
  body: string;
}

type CustomerEmailSender = typeof sendTransactionalEmail;
type CustomerNotificationEmailSourceCategory = Exclude<
  OrganizationEmailCategory,
  "verification" | "service_summary"
>;

export function customerNotificationEmailCategory(
  idempotencyKey: string,
): CustomerNotificationEmailSourceCategory | null {
  if (
    idempotencyKey.startsWith("installation-suspended:") ||
    idempotencyKey.startsWith("installation-restored:") ||
    idempotencyKey.startsWith("installation-removed:")
  ) {
    return "security";
  }
  if (
    idempotencyKey.startsWith("subscription-past-due:") ||
    idempotencyKey.startsWith("billing-settlement-failed:")
  ) {
    return "payment_failure";
  }
  if (idempotencyKey.startsWith("trial-expired:")) return "trial_expiry";
  if (
    idempotencyKey.startsWith("service-disruption:") ||
    idempotencyKey.startsWith("service-recovery:")
  ) {
    return "service_incident";
  }
  if (
    idempotencyKey.startsWith("subscription-restored:") ||
    idempotencyKey.startsWith("subscription-paused:") ||
    idempotencyKey.startsWith("subscription-canceled:")
  ) {
    return "billing_summary";
  }
  return null;
}

export async function scheduleCustomerNotificationEmailJobs(
  db: Database,
  now = new Date(),
): Promise<{ queued: number; suppressed: number; events: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('postil:customer-notification-email-scheduler', 0))`,
    );
    const optionalCutoff = new Date(
      now.getTime() - CUSTOMER_EMAIL_SUMMARY_DELAY_MS,
    );
    const candidates = await tx
      .select({
        eventId: schema.customerNotificationEvents.id,
        orgId: schema.customerNotificationEvents.orgId,
        idempotencyKey: schema.customerNotificationEvents.idempotencyKey,
        billingContactEmail:
          schema.organizationEntitlements.billingContactEmail,
        billingContactVerifiedAt:
          schema.organizationEntitlements.billingContactVerifiedAt,
        billingSummaryEmail:
          schema.organizationNotificationPreferences.billingSummaryEmail,
        serviceSummaryEmail:
          schema.organizationNotificationPreferences.serviceSummaryEmail,
      })
      .from(schema.customerNotificationEvents)
      .leftJoin(
        schema.customerNotificationEmailDeliveryEvents,
        eq(
          schema.customerNotificationEmailDeliveryEvents.eventId,
          schema.customerNotificationEvents.id,
        ),
      )
      .leftJoin(
        schema.organizationEntitlements,
        eq(
          schema.organizationEntitlements.orgId,
          schema.customerNotificationEvents.orgId,
        ),
      )
      .leftJoin(
        schema.organizationNotificationPreferences,
        eq(
          schema.organizationNotificationPreferences.orgId,
          schema.customerNotificationEvents.orgId,
        ),
      )
      .where(
        and(
          isNull(schema.customerNotificationEmailDeliveryEvents.eventId),
          or(
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "installation-suspended:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "installation-restored:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "installation-removed:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "subscription-past-due:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "billing-settlement-failed:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "trial-expired:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "service-disruption:%",
            ),
            like(
              schema.customerNotificationEvents.idempotencyKey,
              "service-recovery:%",
            ),
            and(
              lte(schema.customerNotificationEvents.createdAt, optionalCutoff),
              or(
                like(
                  schema.customerNotificationEvents.idempotencyKey,
                  "subscription-restored:%",
                ),
                like(
                  schema.customerNotificationEvents.idempotencyKey,
                  "subscription-paused:%",
                ),
                like(
                  schema.customerNotificationEvents.idempotencyKey,
                  "subscription-canceled:%",
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.customerNotificationEvents.id))
      .limit(CUSTOMER_EMAIL_SCAN_LIMIT);

    const grouped = new Map<
      string,
      {
        orgId: number;
        emailCategory: CustomerNotificationEmailSourceCategory;
        eventIds: number[];
        hasVerifiedContact: boolean;
        billingSummaryEmail: boolean;
        serviceSummaryEmail: boolean;
      }
    >();
    for (const candidate of candidates) {
      const emailCategory = customerNotificationEmailCategory(
        candidate.idempotencyKey,
      );
      if (!emailCategory) continue;
      const key = `${candidate.orgId}:${emailCategory}`;
      const group = grouped.get(key) ?? {
        orgId: candidate.orgId,
        emailCategory,
        eventIds: [],
        hasVerifiedContact: Boolean(
          candidate.billingContactEmail && candidate.billingContactVerifiedAt,
        ),
        billingSummaryEmail:
          candidate.billingSummaryEmail ??
          DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES.billingSummaryEmail,
        serviceSummaryEmail:
          candidate.serviceSummaryEmail ??
          DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES.serviceSummaryEmail,
      };
      group.eventIds.push(candidate.eventId);
      grouped.set(key, group);
    }

    let queued = 0;
    let suppressed = 0;
    let events = 0;
    for (const group of grouped.values()) {
      for (
        let offset = 0;
        offset < group.eventIds.length;
        offset += CUSTOMER_EMAIL_BATCH_SIZE
      ) {
        const eventIds = group.eventIds.slice(
          offset,
          offset + CUSTOMER_EMAIL_BATCH_SIZE,
        );
        const preferences = {
          billingSummaryEmail: group.billingSummaryEmail,
          serviceSummaryEmail: group.serviceSummaryEmail,
        };
        const enabled = organizationEmailEnabled(
          group.emailCategory,
          preferences,
        );
        const status = group.hasVerifiedContact && enabled
          ? "queued"
          : "suppressed";
        const lastError = group.hasVerifiedContact
          ? enabled
            ? null
            : "email preference disabled"
          : "verified billing contact unavailable";
        const [delivery] = await tx
          .insert(schema.customerNotificationEmailDeliveries)
          .values({
            orgId: group.orgId,
            emailCategory: group.emailCategory,
            eventCount: eventIds.length,
            status,
            lastError,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: schema.customerNotificationEmailDeliveries.id });
        if (!delivery) {
          throw new Error("customer notification email delivery insert returned no row");
        }
        await tx.insert(schema.customerNotificationEmailDeliveryEvents).values(
          eventIds.map((eventId) => ({ eventId, deliveryId: delivery.id })),
        );
        if (status === "queued") {
          await tx.insert(schema.jobs).values({
            kind: "customer-notification-email",
            payload: { deliveryId: delivery.id },
            maxAttempts: 5,
          });
          queued += 1;
        } else {
          suppressed += 1;
        }
        events += eventIds.length;
      }
    }
    return { queued, suppressed, events };
  });
}

export async function runCustomerNotificationEmailJob(
  db: Database,
  payload: CustomerNotificationEmailJobPayload,
  options: {
    publicOrigin: string;
    apiKey: string;
    send?: CustomerEmailSender;
    now?: Date;
  },
): Promise<"delivered" | "suppressed" | "noop"> {
  validateCustomerNotificationEmailJobPayload(payload);
  const delivery = (
    await db
      .select({
        id: schema.customerNotificationEmailDeliveries.id,
        orgId: schema.customerNotificationEmailDeliveries.orgId,
        emailCategory:
          schema.customerNotificationEmailDeliveries.emailCategory,
        eventCount: schema.customerNotificationEmailDeliveries.eventCount,
        status: schema.customerNotificationEmailDeliveries.status,
        orgName: schema.organizations.name,
        orgSlug: schema.organizations.slug,
        billingContactEmail:
          schema.organizationEntitlements.billingContactEmail,
        billingContactVerifiedAt:
          schema.organizationEntitlements.billingContactVerifiedAt,
        billingSummaryEmail:
          schema.organizationNotificationPreferences.billingSummaryEmail,
        serviceSummaryEmail:
          schema.organizationNotificationPreferences.serviceSummaryEmail,
      })
      .from(schema.customerNotificationEmailDeliveries)
      .innerJoin(
        schema.organizations,
        eq(
          schema.organizations.id,
          schema.customerNotificationEmailDeliveries.orgId,
        ),
      )
      .leftJoin(
        schema.organizationEntitlements,
        eq(
          schema.organizationEntitlements.orgId,
          schema.customerNotificationEmailDeliveries.orgId,
        ),
      )
      .leftJoin(
        schema.organizationNotificationPreferences,
        eq(
          schema.organizationNotificationPreferences.orgId,
          schema.customerNotificationEmailDeliveries.orgId,
        ),
      )
      .where(eq(schema.customerNotificationEmailDeliveries.id, payload.deliveryId))
      .limit(1)
  )[0];
  if (!delivery) {
    throw new PermanentJobError("customer notification email delivery is missing");
  }
  if (delivery.status === "delivered" || delivery.status === "suppressed") {
    return "noop";
  }
  if (delivery.status === "failed") return "noop";
  const emailCategory = validateCustomerNotificationEmailSourceCategory(
    delivery.emailCategory,
  );
  const now = options.now ?? new Date();
  const staleClaimCutoff = new Date(
    now.getTime() - CUSTOMER_EMAIL_CLAIM_TIMEOUT_MS,
  );
  const claimed = await db
    .update(schema.customerNotificationEmailDeliveries)
    .set({
      status: "sending",
      lastAttemptAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.customerNotificationEmailDeliveries.id, delivery.id),
        or(
          inArray(schema.customerNotificationEmailDeliveries.status, [
            "queued",
            "retrying",
          ]),
          and(
            eq(schema.customerNotificationEmailDeliveries.status, "sending"),
            or(
              isNull(schema.customerNotificationEmailDeliveries.lastAttemptAt),
              lte(
                schema.customerNotificationEmailDeliveries.lastAttemptAt,
                staleClaimCutoff,
              ),
            ),
          ),
        ),
      ),
    )
    .returning({ id: schema.customerNotificationEmailDeliveries.id });
  if (claimed.length === 0) return "noop";
  const preferences = {
    billingSummaryEmail:
      delivery.billingSummaryEmail ??
      DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES.billingSummaryEmail,
    serviceSummaryEmail:
      delivery.serviceSummaryEmail ??
      DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES.serviceSummaryEmail,
  };
  if (
    !delivery.billingContactEmail ||
    !delivery.billingContactVerifiedAt ||
    !organizationEmailEnabled(emailCategory, preferences)
  ) {
    await suppressCustomerNotificationEmailDelivery(
      db,
      delivery.id,
      delivery.billingContactEmail && delivery.billingContactVerifiedAt
        ? "email preference disabled"
        : "verified billing contact unavailable",
      now,
    );
    return "suppressed";
  }
  const rows = await db
    .select({
      id: schema.customerNotificationEvents.id,
      idempotencyKey: schema.customerNotificationEvents.idempotencyKey,
      severity: schema.customerNotificationEvents.severity,
      title: schema.customerNotificationEvents.title,
      body: schema.customerNotificationEvents.body,
    })
    .from(schema.customerNotificationEmailDeliveryEvents)
    .innerJoin(
      schema.customerNotificationEvents,
      eq(
        schema.customerNotificationEvents.id,
        schema.customerNotificationEmailDeliveryEvents.eventId,
      ),
    )
    .where(
      eq(
        schema.customerNotificationEmailDeliveryEvents.deliveryId,
        delivery.id,
      ),
    )
    .orderBy(asc(schema.customerNotificationEvents.id));
  const events = rows.filter(
    (event) =>
      customerNotificationEmailCategory(event.idempotencyKey) === emailCategory,
  );
  if (events.length !== delivery.eventCount) {
    throw new PermanentJobError(
      "customer notification email events are incomplete",
    );
  }
  const message = customerNotificationSummaryEmailContent({
    orgName: delivery.orgName,
    orgSlug: delivery.orgSlug,
    emailCategory,
    events,
    publicOrigin: options.publicOrigin,
  });
  const emailInput = {
    recipient: delivery.billingContactEmail,
    subject: message.subject,
    content: message.content,
    idempotencyKey: `postil-customer-email-${delivery.id}`,
    apiKey: options.apiKey,
  };
  const result = options.send
    ? await options.send(emailInput)
    : await sendTransactionalEmail(emailInput);
  const delivered = await db
    .update(schema.customerNotificationEmailDeliveries)
    .set({
      status: "delivered",
      messageId: result.messageId,
      lastError: null,
      lastAttemptAt: now,
      deliveredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.customerNotificationEmailDeliveries.id, delivery.id),
        eq(schema.customerNotificationEmailDeliveries.status, "sending"),
      ),
    )
    .returning({ id: schema.customerNotificationEmailDeliveries.id });
  if (delivered.length === 0) {
    throw new Error("customer notification email delivery claim was lost");
  }
  return "delivered";
}

export async function recordCustomerNotificationEmailFailure(
  db: Database,
  payload: Record<string, unknown>,
  error: string,
  terminal: boolean,
  now = new Date(),
): Promise<void> {
  if (
    typeof payload.deliveryId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.deliveryId,
    )
  ) {
    return;
  }
  await db
    .update(schema.customerNotificationEmailDeliveries)
    .set({
      status: terminal ? "failed" : "retrying",
      lastError: error.slice(0, 2_000),
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.customerNotificationEmailDeliveries.id, payload.deliveryId),
        inArray(schema.customerNotificationEmailDeliveries.status, [
          "queued",
          "retrying",
          "sending",
        ]),
      ),
    );
}

export function customerNotificationSummaryEmailContent(input: {
  orgName: string;
  orgSlug: string;
  emailCategory: OrganizationEmailCategory;
  events: readonly CustomerNotificationEmailEvent[];
  publicOrigin: string;
}): { subject: string; content: TransactionalEmailContent } {
  if (input.events.length < 1 || input.events.length > CUSTOMER_EMAIL_BATCH_SIZE) {
    throw new Error("customer notification email batch must contain 1..20 events");
  }
  const orgName = sanitizeVerificationLabel(input.orgName);
  const descriptor = emailDescriptor(input.emailCategory, input.events);
  const notificationsUrl = new URL(
    `/orgs/${encodeURIComponent(input.orgSlug)}/notifications`,
    input.publicOrigin,
  ).toString();
  return {
    subject: `${descriptor.subject} for ${orgName}`,
    content: {
      preheader: descriptor.preheader,
      category: descriptor.category,
      title: descriptor.title,
      summary: descriptor.summary,
      organization: orgName,
      reason: descriptor.reason,
      details: input.events.map((event) => ({
        label: event.title,
        value: event.body,
      })),
      action: { label: "Open notifications", url: notificationsUrl },
      note: descriptor.note,
      intent: descriptor.intent,
    },
  };
}

function emailDescriptor(
  emailCategory: OrganizationEmailCategory,
  events: readonly CustomerNotificationEmailEvent[],
): {
  subject: string;
  preheader: string;
  category: string;
  title: string;
  summary: string;
  reason: string;
  note?: string;
  intent: "notice" | "success" | "warning" | "critical";
} {
  const eventLabel = `${events.length} update${events.length === 1 ? "" : "s"}`;
  if (emailCategory === "billing_summary") {
    return {
      subject: "Postil billing summary",
      preheader: `${eventLabel} about your Postil subscription.`,
      category: "Billing summary",
      title: "Billing summary",
      summary: `${eventLabel} about your Postil subscription.`,
      reason: "This address is the verified billing contact, and billing summaries are enabled.",
      note: "Organization administrators can change optional email preferences from billing settings.",
      intent: events.some((event) => event.severity === "warning")
        ? "warning"
        : "notice",
    };
  }
  if (emailCategory === "payment_failure") {
    return {
      subject: "Postil billing action needed",
      preheader: "A payment issue needs attention.",
      category: "Billing",
      title: "Billing action needed",
      summary: "A payment issue may affect private-repository reviews.",
      reason: "This address is the verified billing contact. Payment-failure email cannot be disabled.",
      intent: "critical",
    };
  }
  if (emailCategory === "security") {
    return {
      subject: "Postil security update",
      preheader: `${eventLabel} about GitHub App access.`,
      category: "Security",
      title: "GitHub App access update",
      summary: `${eventLabel} about the organization's GitHub App access.`,
      reason: "This address is the verified billing contact. Security email cannot be disabled.",
      intent: events.some((event) => event.severity === "critical")
        ? "critical"
        : events.some((event) => event.severity === "warning")
          ? "warning"
          : "success",
    };
  }
  if (emailCategory === "trial_expiry") {
    return {
      subject: "Postil trial update",
      preheader: "Your Postil trial has ended.",
      category: "Trial",
      title: "Your trial has ended",
      summary: "Review the organization notification for available next steps.",
      reason: "This address is the verified billing contact. Trial-expiry email cannot be disabled.",
      intent: "warning",
    };
  }
  if (emailCategory === "service_incident") {
    const recovered = events.every((event) => event.severity === "info");
    return {
      subject: recovered ? "Postil service recovered" : "Postil service update",
      preheader: recovered
        ? "Postil service has recovered."
        : "A Postil service issue may affect your organization.",
      category: "Service",
      title: recovered ? "Service recovered" : "Service update",
      summary: recovered
        ? "Postil service is available again."
        : "A service issue may affect dashboard or review activity.",
      reason: "This address is the verified billing contact. Service-incident email cannot be disabled.",
      intent: recovered ? "success" : "critical",
    };
  }
  throw new Error(`customer notification email category ${emailCategory} has no durable source`);
}

async function suppressCustomerNotificationEmailDelivery(
  db: Database,
  deliveryId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db
    .update(schema.customerNotificationEmailDeliveries)
    .set({
      status: "suppressed",
      lastError: reason,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.customerNotificationEmailDeliveries.id, deliveryId),
        eq(schema.customerNotificationEmailDeliveries.status, "sending"),
      ),
    );
}

function validateCustomerNotificationEmailJobPayload(
  payload: CustomerNotificationEmailJobPayload,
): void {
  if (
    typeof payload.deliveryId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      payload.deliveryId,
    )
  ) {
    throw new PermanentJobError(
      "customer notification email job payload is malformed",
    );
  }
}

function validateCustomerNotificationEmailSourceCategory(
  value: string,
): CustomerNotificationEmailSourceCategory {
  if (
    [
      "security",
      "payment_failure",
      "trial_expiry",
      "service_incident",
      "billing_summary",
    ].includes(value)
  ) {
    return value as CustomerNotificationEmailSourceCategory;
  }
  throw new PermanentJobError(
    "customer notification email category has no durable source",
  );
}
