import { Paddle, Environment, type EventEntity } from "@paddle/paddle-node-sdk";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { optionalEnv, requireEnv } from "@/lib/env";
import {
  enqueueOperatorAlert,
  type SubscriptionAlertPayload,
} from "@/lib/operator-alerts";

const CHECKOUT_TTL_MS = 30 * 60 * 1_000;
const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const SETTLEMENT_RECONCILE_DELAY_MS = 2 * 60 * 1_000;
const SETTLEMENT_AMBIGUITY_LIMIT_MS = 60 * 60 * 1_000;
const CHECKOUT_CUSTOM_DATA_KEY = "postil_checkout_id";
const SETTLEMENT_CUSTOM_DATA_KEY = "postil_settlement_id";
const CHECKOUT_CONTRACT_KEY = "postil_billing_contract";
const CHECKOUT_CONTRACT_VERSION = "1";
const OPEN_CHECKOUT_STATUSES = ["creating", "pending"] as const;

export interface PaddleCheckoutConfiguration {
  clientToken: string;
  environment: "sandbox" | "production";
}

export interface PaddleCheckoutResult extends PaddleCheckoutConfiguration {
  transactionId: string;
}

export interface BillingSettlementJobPayload {
  settlementId: string;
}

export function paddleCheckoutConfiguration(): PaddleCheckoutConfiguration | null {
  if (optionalEnv("POSTIL_PADDLE_BILLING_ENABLED") !== "1") return null;
  const clientToken = optionalEnv("PADDLE_CLIENT_TOKEN")?.trim();
  const environment = optionalEnv("PADDLE_ENVIRONMENT")?.trim();
  if (
    !clientToken ||
    (environment !== "sandbox" && environment !== "production")
  ) {
    return null;
  }
  return { clientToken, environment };
}

function paddleClient(): Paddle {
  return new Paddle(requireEnv("PADDLE_API_KEY"), {
    environment:
      requireEnv("PADDLE_ENVIRONMENT") === "sandbox"
        ? Environment.sandbox
        : Environment.production,
  });
}

/** Create one provider transaction while serializing concurrent checkout clicks per org. */
export async function createPaddleCheckout(
  db: Database,
  input: {
    orgId: number;
    orgSlug: string;
    requestedByUserId: number;
    now?: Date;
  },
  client = paddleClient(),
): Promise<PaddleCheckoutResult> {
  const configuration = paddleCheckoutConfiguration();
  if (!configuration) throw new Error("Paddle checkout is not configured");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS);

  const checkout = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paddle-checkout:${input.orgId}`}, 0))`,
    );
    const subscription = (
      await tx
        .select({ status: schema.billingProviderSubscriptions.status })
        .from(schema.billingProviderSubscriptions)
        .where(eq(schema.billingProviderSubscriptions.orgId, input.orgId))
        .limit(1)
    )[0];
    if (subscription && subscription.status !== "canceled") {
      throw new Error("billing subscription is already active");
    }
    const existing = (
      await tx
        .select({
          id: schema.billingCheckoutTransactions.id,
          status: schema.billingCheckoutTransactions.status,
          providerTransactionId:
            schema.billingCheckoutTransactions.providerTransactionId,
          createdAt: schema.billingCheckoutTransactions.createdAt,
          expiresAt: schema.billingCheckoutTransactions.expiresAt,
        })
        .from(schema.billingCheckoutTransactions)
        .where(
          and(
            eq(schema.billingCheckoutTransactions.orgId, input.orgId),
            inArray(schema.billingCheckoutTransactions.status, [
              ...OPEN_CHECKOUT_STATUSES,
            ]),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { ...existing, created: false };
    const created = (
      await tx
        .insert(schema.billingCheckoutTransactions)
        .values({
          orgId: input.orgId,
          requestedByUserId: input.requestedByUserId,
          expiresAt,
        })
        .returning({ id: schema.billingCheckoutTransactions.id })
    )[0];
    if (!created) throw new Error("checkout admission failed");
    return {
      id: created.id,
      status: "creating" as const,
      providerTransactionId: null,
      createdAt: now,
      expiresAt,
      created: true,
    };
  });

  if (checkout.providerTransactionId) {
    return { ...configuration, transactionId: checkout.providerTransactionId };
  }
  if (!checkout.created) {
    const recovered = await findPaddleCheckoutTransaction(client, checkout);
    if (recovered === "multiple") {
      await enqueueCheckoutAnomaly(db, input, checkout.id);
      throw new Error("multiple Paddle checkout transactions matched");
    }
    if (recovered) {
      await storePaddleCheckoutTransaction(db, checkout.id, recovered, now);
      return { ...configuration, transactionId: recovered.id };
    }
    if (now < checkout.expiresAt) {
      throw new Error("checkout creation is already in progress");
    }
    const released = await db
      .update(schema.billingCheckoutTransactions)
      .set({
        status: "failed",
        lastErrorCategory: "provider_transaction_not_found",
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.billingCheckoutTransactions.id, checkout.id),
          eq(schema.billingCheckoutTransactions.status, "creating"),
          sql`${schema.billingCheckoutTransactions.providerTransactionId} IS NULL`,
        ),
      )
      .returning({ id: schema.billingCheckoutTransactions.id });
    if (released.length === 0) {
      throw new Error("checkout state changed during reconciliation");
    }
    return createPaddleCheckout(db, { ...input, now }, client);
  }

  let transaction;
  try {
    transaction = await client.transactions.create({
      items: [
        { priceId: requireEnv("PADDLE_ZERO_BASE_PRICE_ID"), quantity: 1 },
      ],
      collectionMode: "automatic",
      customData: {
        [CHECKOUT_CUSTOM_DATA_KEY]: checkout.id,
        [CHECKOUT_CONTRACT_KEY]: CHECKOUT_CONTRACT_VERSION,
      },
      checkout: {
        url: new URL(
          `/orgs/${encodeURIComponent(input.orgSlug)}/billing`,
          requireEnv("POSTIL_PUBLIC_URL"),
        ).toString(),
      },
    });
  } catch {
    await db
      .update(schema.billingCheckoutTransactions)
      .set({
        lastErrorCategory: "provider_outcome_uncertain",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.billingCheckoutTransactions.id, checkout.id),
          eq(schema.billingCheckoutTransactions.status, "creating"),
        ),
      );
    throw new Error("Paddle checkout creation failed");
  }
  await storePaddleCheckoutTransaction(db, checkout.id, transaction, new Date());
  return { ...configuration, transactionId: transaction.id };
}

type CheckoutCandidate = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
};

async function findPaddleCheckoutTransaction(
  client: Paddle,
  checkout: CheckoutCandidate,
): Promise<
  | "multiple"
  | Awaited<ReturnType<Paddle["transactions"]["get"]>>
  | undefined
> {
  const matches = [];
  const transactions = client.transactions.list({
    origin: ["api"],
    "createdAt[GTE]": new Date(
      checkout.createdAt.getTime() - 60_000,
    ).toISOString(),
    perPage: 30,
  });
  for await (const transaction of transactions) {
    if (
      checkoutIdFromCustomData(transaction.customData) === checkout.id &&
      transaction.items.some(
        (item) =>
          item.price?.id === requireEnv("PADDLE_ZERO_BASE_PRICE_ID") &&
          item.quantity === 1,
      )
    ) {
      matches.push(transaction);
    }
  }
  if (matches.length > 1) return "multiple";
  return matches[0];
}

async function enqueueCheckoutAnomaly(
  db: Database,
  input: { orgId: number; orgSlug: string },
  checkoutId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const organization = (
      await tx
        .select({
          name: schema.organizations.name,
          githubOwnerId: schema.organizations.githubOrgId,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, input.orgId))
        .limit(1)
    )[0];
    if (!organization?.githubOwnerId) return;
    await enqueueOperatorAlert(tx, {
      event: "billing_anomaly",
      eventKey: `billing-anomaly:${checkoutId}:checkout-failed`,
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      accountLogin: organization.name,
      githubOwnerId: organization.githubOwnerId,
      providerObjectId: checkoutId,
      category: "checkout_failed",
    });
  });
}

async function storePaddleCheckoutTransaction(
  db: Database,
  checkoutId: string,
  transaction: {
    id: string;
    checkout: { url: string | null } | null;
  },
  now: Date,
): Promise<void> {
  const stored = await db
    .update(schema.billingCheckoutTransactions)
    .set({
      providerTransactionId: transaction.id,
      checkoutUrl: transaction.checkout?.url ?? null,
      status: "pending",
      lastErrorCategory: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.billingCheckoutTransactions.id, checkoutId),
        eq(schema.billingCheckoutTransactions.status, "creating"),
      ),
    )
    .returning({ id: schema.billingCheckoutTransactions.id });
  if (stored.length === 0) {
    throw new Error("checkout transaction could not be recorded");
  }
}

export async function unmarshalPaddleWebhook(
  rawBody: string,
  signature: string,
): Promise<EventEntity> {
  return paddleClient().webhooks.unmarshal(
    rawBody,
    requireEnv("PADDLE_WEBHOOK_SECRET"),
    signature,
  );
}

export async function createPaddlePortalSession(
  db: Database,
  orgId: number,
): Promise<string> {
  if (!paddleCheckoutConfiguration()) {
    throw new Error("Paddle billing is not configured");
  }
  const subscription = (
    await db
      .select({
        providerCustomerId:
          schema.billingProviderSubscriptions.providerCustomerId,
        providerSubscriptionId:
          schema.billingProviderSubscriptions.providerSubscriptionId,
      })
      .from(schema.billingProviderSubscriptions)
      .where(eq(schema.billingProviderSubscriptions.orgId, orgId))
      .limit(1)
  )[0];
  if (!subscription) throw new Error("billing subscription is missing");
  const session = await paddleClient().customerPortalSessions.create(
    subscription.providerCustomerId,
    [subscription.providerSubscriptionId],
  );
  return session.urls.general.overview;
}

type SubscriptionEvent = Extract<
  EventEntity,
  { eventType: `subscription.${string}` }
>;

function isSubscriptionEvent(event: EventEntity): event is SubscriptionEvent {
  return event.eventType.startsWith("subscription.");
}

function checkoutIdFromCustomData(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const customData = value as Record<string, unknown>;
  if (customData[CHECKOUT_CONTRACT_KEY] !== CHECKOUT_CONTRACT_VERSION)
    return null;
  const checkoutId = customData[CHECKOUT_CUSTOM_DATA_KEY];
  return typeof checkoutId === "string" && /^[0-9a-f-]{36}$/i.test(checkoutId)
    ? checkoutId
    : null;
}

function settlementIdFromCustomData(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const customData = value as Record<string, unknown>;
  if (customData[CHECKOUT_CONTRACT_KEY] !== CHECKOUT_CONTRACT_VERSION)
    return null;
  const settlementId = customData[SETTLEMENT_CUSTOM_DATA_KEY];
  return typeof settlementId === "string" &&
    /^[0-9a-f-]{36}$/i.test(settlementId)
    ? settlementId
    : null;
}

function eventDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Paddle event date is invalid");
  return parsed;
}

function mapSubscriptionStatus(
  status: string,
): "active" | "trialing" | "past_due" | "paused" | "canceled" {
  if (
    ["active", "trialing", "past_due", "paused", "canceled"].includes(status)
  ) {
    return status as "active" | "trialing" | "past_due" | "paused" | "canceled";
  }
  throw new Error("Paddle subscription status is unsupported");
}

function subscriptionAlertEvent(
  previousStatus: string | undefined,
  status: "active" | "trialing" | "past_due" | "paused" | "canceled",
): SubscriptionAlertPayload["event"] | null {
  if (
    (status === "active" || status === "trialing") &&
    previousStatus !== "active" &&
    previousStatus !== "trialing"
  ) {
    return "subscription_started";
  }
  if (status === "past_due" && previousStatus !== status) {
    return "subscription_past_due";
  }
  if (status === "paused" && previousStatus !== status) {
    return "subscription_paused";
  }
  if (status === "canceled" && previousStatus !== status) {
    return "subscription_canceled";
  }
  return null;
}

async function closePriorBillingPeriod(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: {
    orgId: number;
    providerSubscriptionId: string;
    previousStatus: string | undefined;
    previousPeriodStartsAt: Date | null | undefined;
    previousPeriodEndsAt: Date | null | undefined;
    nextPeriodStartsAt: Date | null;
    nextPeriodEndsAt: Date | null;
    now: Date;
  },
): Promise<void> {
  if (
    input.previousStatus !== "active" ||
    !input.previousPeriodStartsAt ||
    !input.previousPeriodEndsAt ||
    !input.nextPeriodStartsAt ||
    !input.nextPeriodEndsAt ||
    input.nextPeriodStartsAt < input.previousPeriodEndsAt ||
    input.nextPeriodEndsAt <= input.previousPeriodEndsAt
  ) {
    return;
  }

  const entitlement = (
    await tx
      .select({ trialEndsAt: schema.organizationEntitlements.trialEndsAt })
      .from(schema.organizationEntitlements)
      .where(eq(schema.organizationEntitlements.orgId, input.orgId))
      .limit(1)
  )[0];
  const periodStartsAt =
    entitlement?.trialEndsAt &&
    entitlement.trialEndsAt > input.previousPeriodStartsAt
      ? entitlement.trialEndsAt
      : input.previousPeriodStartsAt;
  const periodEndsAt = input.previousPeriodEndsAt;
  if (periodStartsAt >= periodEndsAt) return;

  const activeAuthorCount =
    (
      await tx
        .select({
          count: sql<number>`COUNT(DISTINCT ${schema.reviews.authorGithubId})::int`,
        })
        .from(schema.reviews)
        .innerJoin(
          schema.repositories,
          eq(schema.repositories.id, schema.reviews.repositoryId),
        )
        .innerJoin(
          schema.installations,
          eq(schema.installations.id, schema.repositories.installationId),
        )
        .where(
          and(
            eq(schema.installations.orgId, input.orgId),
            eq(schema.repositories.private, true),
            gte(schema.reviews.queuedAt, periodStartsAt),
            lt(schema.reviews.queuedAt, periodEndsAt),
          ),
        )
    )[0]?.count ?? 0;
  const settlement = (
    await tx
      .insert(schema.billingAuthorSettlements)
      .values({
        orgId: input.orgId,
        providerSubscriptionId: input.providerSubscriptionId,
        periodStartsAt,
        periodEndsAt,
        activeAuthorCount,
        totalAmountCents: activeAuthorCount * 600,
        status: activeAuthorCount === 0 ? "no_charge" : "pending",
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.billingAuthorSettlements.id })
  )[0];
  if (settlement && activeAuthorCount > 0) {
    await tx.insert(schema.jobs).values({
      kind: "billing-settlement",
      payload: { settlementId: settlement.id },
      maxAttempts: 5,
    });
  }
}

/** Apply one verified provider event atomically and without storing its PII payload. */
export async function applyPaddleWebhookEvent(
  db: Database,
  event: EventEntity,
  now = new Date(),
  client?: Paddle,
): Promise<{
  duplicate: boolean;
  outcome: "applied" | "stale" | "ignored" | "unmatched";
}> {
  return db.transaction(async (tx) => {
    const occurredAt = eventDate(event.occurredAt);
    const initialProviderObjectId = isSubscriptionEvent(event)
      ? event.data.id
      : null;
    const claimed = await tx
      .insert(schema.billingProviderEvents)
      .values({
        eventId: event.eventId,
        eventType: event.eventType,
        providerObjectId: initialProviderObjectId,
        occurredAt,
        outcome: "processing",
        processedAt: now,
      })
      .onConflictDoNothing({ target: schema.billingProviderEvents.eventId })
      .returning({ eventId: schema.billingProviderEvents.eventId });
    if (claimed.length === 0) {
      return { duplicate: true, outcome: "ignored" as const };
    }

    let orgId: number | null = null;
    let providerObjectId: string | null = null;
    let outcome: "applied" | "stale" | "ignored" | "unmatched" = "ignored";

    if (isSubscriptionEvent(event)) {
      providerObjectId = event.data.id;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paddle-subscription:${providerObjectId}`}, 0))`,
      );
      const existing = (
        await tx
          .select()
          .from(schema.billingProviderSubscriptions)
          .where(
            eq(
              schema.billingProviderSubscriptions.providerSubscriptionId,
              providerObjectId,
            ),
          )
          .limit(1)
      )[0];
      orgId = existing?.orgId ?? null;
      const checkoutId = checkoutIdFromCustomData(event.data.customData);
      if (orgId === null && checkoutId) {
        orgId = (
          await tx
            .select({ orgId: schema.billingCheckoutTransactions.orgId })
            .from(schema.billingCheckoutTransactions)
            .where(
              and(
                eq(schema.billingCheckoutTransactions.id, checkoutId),
                inArray(schema.billingCheckoutTransactions.status, [
                  ...OPEN_CHECKOUT_STATUSES,
                ]),
              ),
            )
            .limit(1)
        )[0]?.orgId ?? null;
      }
      const orgSubscription =
        orgId === null
          ? undefined
          : (
              await tx
                .select({
                  providerSubscriptionId:
                    schema.billingProviderSubscriptions
                      .providerSubscriptionId,
                  status: schema.billingProviderSubscriptions.status,
                })
                .from(schema.billingProviderSubscriptions)
                .where(eq(schema.billingProviderSubscriptions.orgId, orgId))
                .limit(1)
            )[0];
      if (
        orgSubscription &&
        orgSubscription.providerSubscriptionId !== providerObjectId &&
        orgSubscription.status !== "canceled"
      ) {
        orgId = null;
      }
      if (orgId === null) {
        outcome = "unmatched";
        await enqueueOperatorAlert(tx, {
          event: "billing_anomaly",
          eventKey: `billing-anomaly:${event.eventId}:unmatched-provider-event`,
          orgId: null,
          orgSlug: null,
          accountLogin: null,
          githubOwnerId: null,
          providerObjectId,
          category: "unmatched_provider_event",
        });
      } else if (existing && occurredAt < existing.latestEventOccurredAt) {
        outcome = "stale";
      } else {
        const providerState =
          existing && occurredAt.getTime() === existing.latestEventOccurredAt.getTime()
            ? await (client ?? paddleClient()).subscriptions.get(providerObjectId)
            : event.data;
        const status = mapSubscriptionStatus(providerState.status);
        const periodStartsAt = providerState.currentBillingPeriod
          ? eventDate(providerState.currentBillingPeriod.startsAt)
          : null;
        const periodEndsAt = providerState.currentBillingPeriod
          ? eventDate(providerState.currentBillingPeriod.endsAt)
          : null;
        await closePriorBillingPeriod(tx, {
          orgId,
          providerSubscriptionId: providerObjectId,
          previousStatus: existing?.status,
          previousPeriodStartsAt: existing?.currentPeriodStartsAt,
          previousPeriodEndsAt: existing?.currentPeriodEndsAt,
          nextPeriodStartsAt: periodStartsAt,
          nextPeriodEndsAt: periodEndsAt,
          now,
        });
        await tx
          .insert(schema.billingProviderSubscriptions)
          .values({
            orgId,
            providerSubscriptionId: providerObjectId,
            providerCustomerId: providerState.customerId,
            status,
            currentPeriodStartsAt: periodStartsAt,
            currentPeriodEndsAt: periodEndsAt,
            latestEventOccurredAt: occurredAt,
            latestEventId: event.eventId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.billingProviderSubscriptions.orgId,
            set: {
              providerSubscriptionId: providerObjectId,
              providerCustomerId: providerState.customerId,
              status,
              currentPeriodStartsAt: periodStartsAt,
              currentPeriodEndsAt: periodEndsAt,
              latestEventOccurredAt: occurredAt,
              latestEventId: event.eventId,
              updatedAt: now,
            },
          });

        const entitlementStatus =
          status === "active" || status === "trialing"
            ? "active"
            : status === "past_due"
              ? "past_due"
              : "suspended";
        await tx
          .insert(schema.organizationEntitlements)
          .values({
            orgId,
            subscriptionMode: "byok",
            status: entitlementStatus,
            pastDueGraceEndsAt:
              status === "past_due"
                ? new Date(occurredAt.getTime() + PAST_DUE_GRACE_MS)
                : null,
            periodStartsAt,
            periodEndsAt,
            updatedBy: `paddle:${event.eventType}`,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.organizationEntitlements.orgId,
            set: {
              subscriptionMode: "byok",
              status: entitlementStatus,
              pastDueGraceEndsAt:
                status === "past_due"
                  ? new Date(occurredAt.getTime() + PAST_DUE_GRACE_MS)
                  : null,
              periodStartsAt,
              periodEndsAt,
              updatedBy: `paddle:${event.eventType}`,
              updatedAt: now,
            },
          });
        if (checkoutId) {
          await tx
            .update(schema.billingCheckoutTransactions)
            .set({ status: "completed", updatedAt: now })
            .where(
              and(
                eq(schema.billingCheckoutTransactions.id, checkoutId),
                inArray(schema.billingCheckoutTransactions.status, [
                  ...OPEN_CHECKOUT_STATUSES,
                ]),
              ),
            );
        }
        const alertEvent = subscriptionAlertEvent(existing?.status, status);
        if (alertEvent) {
          const organization = (
            await tx
              .select({
                slug: schema.organizations.slug,
                name: schema.organizations.name,
                githubOwnerId: schema.organizations.githubOrgId,
              })
              .from(schema.organizations)
              .where(eq(schema.organizations.id, orgId))
              .limit(1)
          )[0];
          if (organization?.githubOwnerId) {
            await enqueueOperatorAlert(tx, {
              event: alertEvent,
              eventKey: `${alertEvent}:${providerObjectId}:${event.eventId}`,
              orgId,
              orgSlug: organization.slug,
              accountLogin: organization.name,
              githubOwnerId: organization.githubOwnerId,
              providerSubscriptionId: providerObjectId,
              periodEndsAt: periodEndsAt?.toISOString() ?? null,
            });
          }
        }
        outcome = "applied";
      }
    }

    await tx
      .update(schema.billingProviderEvents)
      .set({ providerObjectId, orgId, outcome, processedAt: now })
      .where(eq(schema.billingProviderEvents.eventId, event.eventId));
    return { duplicate: false, outcome };
  });
}

/** Charge or reconcile one immutable closed-period author count. */
export async function runBillingSettlement(
  db: Database,
  payload: BillingSettlementJobPayload,
  now = new Date(),
  client = paddleClient(),
): Promise<"charged" | "reconciling" | "failed" | "noop"> {
  if (!/^[0-9a-f-]{36}$/i.test(payload.settlementId)) {
    throw new Error("billing settlement job payload is malformed");
  }
  const claimed = (
    await db
      .update(schema.billingAuthorSettlements)
      .set({
        status: "charging",
        attemptCount: sql`${schema.billingAuthorSettlements.attemptCount} + 1`,
        attemptStartedAt: now,
        nextReconcileAt: null,
        lastErrorCategory: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.billingAuthorSettlements.id, payload.settlementId),
          eq(schema.billingAuthorSettlements.status, "pending"),
        ),
      )
      .returning({ id: schema.billingAuthorSettlements.id })
  )[0];

  if (claimed) {
    const settlement = await loadSettlement(db, payload.settlementId);
    if (!settlement) throw new Error("billing settlement disappeared");
    try {
      await client.subscriptions.update(settlement.providerSubscriptionId, {
        customData: {
          [CHECKOUT_CONTRACT_KEY]: CHECKOUT_CONTRACT_VERSION,
          [SETTLEMENT_CUSTOM_DATA_KEY]: settlement.id,
        },
      });
    } catch {
      await db
        .update(schema.billingAuthorSettlements)
        .set({
          status: "pending",
          attemptStartedAt: null,
          lastErrorCategory: "provider_prepare_failed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.billingAuthorSettlements.id, settlement.id),
            eq(schema.billingAuthorSettlements.status, "charging"),
          ),
        );
      throw new Error("Paddle settlement preparation failed");
    }
    try {
      await client.subscriptions.createOneTimeCharge(
        settlement.providerSubscriptionId,
        {
          effectiveFrom: "immediately",
          items: [
            {
              priceId: requireEnv("PADDLE_ACTIVE_AUTHOR_PRICE_ID"),
              quantity: settlement.activeAuthorCount,
            },
          ],
          onPaymentFailure: "apply_change",
        },
      );
    } catch {
      await db
        .update(schema.billingAuthorSettlements)
        .set({
          lastErrorCategory: "provider_outcome_uncertain",
          updatedAt: new Date(),
        })
        .where(eq(schema.billingAuthorSettlements.id, settlement.id));
    }
    await db
      .update(schema.billingAuthorSettlements)
      .set({
        status: "reconciling",
        nextReconcileAt: new Date(
          now.getTime() + SETTLEMENT_RECONCILE_DELAY_MS,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.billingAuthorSettlements.id, settlement.id),
          eq(schema.billingAuthorSettlements.status, "charging"),
        ),
      );
  }

  const settlement = await loadSettlement(db, payload.settlementId);
  if (!settlement || settlement.status !== "reconciling") return "noop";
  if (!settlement.attemptStartedAt) {
    await failSettlement(db, settlement, "settlement_failed", now);
    return "failed";
  }

  const matches = [];
  const transactions = client.transactions.list({
    subscriptionId: [settlement.providerSubscriptionId],
    origin: ["subscription_charge"],
    "createdAt[GTE]": new Date(
      settlement.attemptStartedAt.getTime() - 60_000,
    ).toISOString(),
    perPage: 100,
  });
  for await (const transaction of transactions) {
    if (
      settlementIdFromCustomData(transaction.customData) === settlement.id &&
      transaction.items.some(
        (item) =>
          item.price?.id === requireEnv("PADDLE_ACTIVE_AUTHOR_PRICE_ID") &&
          item.quantity === settlement.activeAuthorCount,
      )
    ) {
      matches.push(transaction);
    }
  }
  if (matches.length > 1) {
    await failSettlement(db, settlement, "settlement_failed", now);
    return "failed";
  }
  const match = matches[0];
  if (match) {
    if (match.status === "canceled") {
      await failSettlement(
        db,
        { ...settlement, providerTransactionId: match.id },
        "settlement_failed",
        now,
      );
      return "failed";
    }
    const charged = match.status === "completed";
    await db
      .update(schema.billingAuthorSettlements)
      .set({
        providerTransactionId: match.id,
        status: charged ? "charged" : "reconciling",
        nextReconcileAt: charged
          ? null
          : new Date(now.getTime() + SETTLEMENT_RECONCILE_DELAY_MS),
        lastErrorCategory: null,
        updatedAt: now,
      })
      .where(eq(schema.billingAuthorSettlements.id, settlement.id));
    return charged ? "charged" : "reconciling";
  }

  if (
    now.getTime() - settlement.attemptStartedAt.getTime() >=
    SETTLEMENT_AMBIGUITY_LIMIT_MS
  ) {
    await failSettlement(db, settlement, "settlement_stale", now);
    return "failed";
  }
  await db
    .update(schema.billingAuthorSettlements)
    .set({
      nextReconcileAt: new Date(now.getTime() + SETTLEMENT_RECONCILE_DELAY_MS),
      updatedAt: now,
    })
    .where(eq(schema.billingAuthorSettlements.id, settlement.id));
  return "reconciling";
}

async function loadSettlement(db: Database, settlementId: string) {
  return (
    await db
      .select()
      .from(schema.billingAuthorSettlements)
      .where(eq(schema.billingAuthorSettlements.id, settlementId))
      .limit(1)
  )[0];
}

async function failSettlement(
  db: Database,
  settlement: NonNullable<Awaited<ReturnType<typeof loadSettlement>>>,
  category: "settlement_stale" | "settlement_failed",
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.billingAuthorSettlements)
      .set({
        status: "failed",
        providerTransactionId: settlement.providerTransactionId,
        nextReconcileAt: null,
        lastErrorCategory: category,
        updatedAt: now,
      })
      .where(eq(schema.billingAuthorSettlements.id, settlement.id));
    const organization = (
      await tx
        .select({
          slug: schema.organizations.slug,
          name: schema.organizations.name,
          githubOwnerId: schema.organizations.githubOrgId,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, settlement.orgId))
        .limit(1)
    )[0];
    if (organization?.githubOwnerId) {
      await enqueueOperatorAlert(tx, {
        event: "billing_anomaly",
        eventKey: `billing-anomaly:${settlement.id}:${category}`,
        orgId: settlement.orgId,
        orgSlug: organization.slug,
        accountLogin: organization.name,
        githubOwnerId: organization.githubOwnerId,
        providerObjectId: settlement.providerSubscriptionId,
        category,
      });
    }
  });
}

/** Recover lost jobs and move uncertain calls to reconciliation without recharging. */
export async function scheduleBillingSettlementJobs(
  db: Database,
  now = new Date(),
): Promise<number> {
  if (optionalEnv("POSTIL_PADDLE_BILLING_ENABLED") !== "1") return 0;
  const staleCharging = new Date(now.getTime() - 10 * 60 * 1_000);
  const result = await db.execute(sql`
    WITH recovered AS (
      UPDATE billing_author_settlements
      SET status = 'reconciling',
          next_reconcile_at = ${now},
          last_error_category = COALESCE(last_error_category, 'worker_interrupted'),
          updated_at = ${now}
      WHERE status = 'charging'
        AND attempt_started_at < ${staleCharging}
    ), due AS (
      SELECT settlement.id
      FROM billing_author_settlements AS settlement
      WHERE (
        settlement.status = 'pending'
        OR (
          settlement.status = 'reconciling'
          AND settlement.next_reconcile_at <= ${now}
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jobs
        WHERE jobs.kind = 'billing-settlement'
          AND jobs.status IN ('queued', 'running')
          AND jobs.payload ->> 'settlementId' = settlement.id::text
      )
      ORDER BY settlement.created_at
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    INSERT INTO jobs (kind, payload, max_attempts)
    SELECT 'billing-settlement', jsonb_build_object('settlementId', due.id), 5
    FROM due
    RETURNING id
  `);
  return result.rowCount ?? 0;
}
