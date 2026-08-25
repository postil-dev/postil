import { and, eq, lte, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  enqueueCustomerNotification,
  trialExpiredNotification,
} from "@/lib/customer-notifications";
import { optionalEnv } from "@/lib/env";
import {
  findingFeedbackAggregates,
  findingFeedbackReconciliationWatermarkReached,
  type FindingFeedbackAggregate,
} from "@/lib/finding-feedback";

export type OperatorAlertEvent =
  | "trial_started"
  | "trial_expired"
  | "installation_removed"
  | "subscription_started"
  | "subscription_past_due"
  | "subscription_paused"
  | "subscription_canceled"
  | "billing_anomaly"
  | "finding_feedback_digest";

interface OperatorAlertBasePayload {
  event: OperatorAlertEvent;
  eventKey: string;
  orgId: number;
  orgSlug: string;
  accountLogin: string;
  githubOwnerId: number;
}

export interface TrialStartedAlertPayload extends OperatorAlertBasePayload {
  event: "trial_started";
  accountType: string;
  githubInstallationId: number;
  trialEndsAt: string;
}

export interface TrialExpiredAlertPayload extends OperatorAlertBasePayload {
  event: "trial_expired";
  trialEndsAt: string;
}

export interface InstallationRemovedAlertPayload extends OperatorAlertBasePayload {
  event: "installation_removed";
  accountType: string;
  githubInstallationId: number;
}

export interface SubscriptionAlertPayload extends OperatorAlertBasePayload {
  event:
    | "subscription_started"
    | "subscription_past_due"
    | "subscription_paused"
    | "subscription_canceled";
  providerSubscriptionId: string;
  periodEndsAt: string | null;
}

export interface BillingAnomalyAlertPayload {
  event: "billing_anomaly";
  eventKey: string;
  orgId: number | null;
  orgSlug: string | null;
  accountLogin: string | null;
  githubOwnerId: number | null;
  providerObjectId: string;
  category:
    | "unmatched_provider_event"
    | "checkout_failed"
    | "settlement_stale"
    | "settlement_failed";
}

export interface FindingFeedbackDigestAlertPayload extends Record<string, unknown> {
  event: "finding_feedback_digest";
  eventKey: string;
  orgId: null;
  orgSlug: null;
  accountLogin: null;
  githubOwnerId: null;
  periodStart: string;
  periodEnd: string;
  aggregates: FindingFeedbackAggregate[];
}

export const MAX_FINDING_FEEDBACK_DIGEST_AGGREGATES = 20;
const FINDING_FEEDBACK_DIGEST_GRACE_MS = 15 * 60 * 1_000;

export type OperatorAlertJobPayload =
  | TrialStartedAlertPayload
  | TrialExpiredAlertPayload
  | InstallationRemovedAlertPayload
  | SubscriptionAlertPayload
  | BillingAnomalyAlertPayload
  | FindingFeedbackDigestAlertPayload;

type AlertWriteDatabase = Pick<Database, "insert">;

/** Insert the audit row and queue job together inside the caller's transaction. */
export async function enqueueOperatorAlert(
  db: AlertWriteDatabase,
  payload: OperatorAlertJobPayload,
): Promise<boolean> {
  if (!optionalEnv("POSTIL_OPERATOR_ALERT_EMAIL")) return false;

  const created = await db
    .insert(schema.operatorAlertDeliveries)
    .values({
      eventKey: payload.eventKey,
      event: payload.event,
      orgId: payload.event === "finding_feedback_digest" ? null : payload.orgId,
      githubInstallationId:
        payload.event === "trial_started" ||
        payload.event === "installation_removed"
          ? payload.githubInstallationId
          : null,
    })
    .onConflictDoNothing({ target: schema.operatorAlertDeliveries.eventKey })
    .returning({ eventKey: schema.operatorAlertDeliveries.eventKey });
  if (created.length === 0) return false;

  await db.insert(schema.jobs).values({
    kind: "operator-alert",
    payload: { ...payload },
    maxAttempts: 5,
  });
  return true;
}

/** Ensure a rolling-deploy or legacy queue job has a durable audit row. */
export async function ensureOperatorAlertDelivery(
  db: Database,
  payload: OperatorAlertJobPayload,
  createdAt = new Date(),
): Promise<void> {
  await db
    .insert(schema.operatorAlertDeliveries)
    .values({
      eventKey: payload.eventKey,
      event: payload.event,
      orgId: payload.event === "finding_feedback_digest" ? null : payload.orgId,
      githubInstallationId:
        payload.event === "trial_started" ||
        payload.event === "installation_removed"
          ? payload.githubInstallationId
          : null,
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing({ target: schema.operatorAlertDeliveries.eventKey });
}

/** Queue one privacy-safe weekly feedback digest when the completed period contains feedback. */
export async function scheduleFindingFeedbackDigest(
  db: Database,
  now = new Date(),
): Promise<"queued" | "empty" | "disabled" | "duplicate" | "pending"> {
  if (!optionalEnv("POSTIL_OPERATOR_ALERT_EMAIL")) return "disabled";
  const latestPeriodEnd = findingFeedbackDigestPeriodEnd(now);
  const periodStart = await oldestUndeliveredFeedbackPeriodStart(db, latestPeriodEnd);
  if (!periodStart) return "empty";
  const periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1_000);
  if (now.getTime() < periodEnd.getTime() + FINDING_FEEDBACK_DIGEST_GRACE_MS) {
    return "pending";
  }
  if (!(await findingFeedbackReconciliationWatermarkReached(db, periodEnd))) {
    return "pending";
  }
  const aggregates = await findingFeedbackAggregates(
    db,
    periodStart,
    periodEnd,
    MAX_FINDING_FEEDBACK_DIGEST_AGGREGATES,
  );
  if (aggregates.length === 0) return "empty";
  const payload: FindingFeedbackDigestAlertPayload = {
    event: "finding_feedback_digest",
    eventKey: `finding-feedback-digest:${periodStart.toISOString().slice(0, 10)}`,
    orgId: null,
    orgSlug: null,
    accountLogin: null,
    githubOwnerId: null,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    aggregates,
  };
  return db.transaction(async (tx) => {
    const requeued = await tx.update(schema.operatorAlertDeliveries).set({
      status: "queued",
      lastError: null,
      updatedAt: now,
    }).where(and(
      eq(schema.operatorAlertDeliveries.eventKey, payload.eventKey),
      eq(schema.operatorAlertDeliveries.status, "failed"),
    )).returning({ eventKey: schema.operatorAlertDeliveries.eventKey });
    const inserted = requeued.length > 0 ? requeued : await tx
      .insert(schema.operatorAlertDeliveries)
      .values({
        eventKey: payload.eventKey,
        event: payload.event,
        orgId: null,
        githubInstallationId: null,
      })
      .onConflictDoNothing({ target: schema.operatorAlertDeliveries.eventKey })
      .returning({ eventKey: schema.operatorAlertDeliveries.eventKey });
    if (inserted.length === 0) return "duplicate";
    await tx.insert(schema.jobs).values({
      kind: "operator-alert",
      payload,
      maxAttempts: 5,
    });
    return "queued";
  });
}

async function oldestUndeliveredFeedbackPeriodStart(
  db: Database,
  latestPeriodEnd: Date,
): Promise<Date | null> {
  const result = await db.execute(sql`
    SELECT date_trunc('week', feedback.observed_at AT TIME ZONE 'UTC') AS "periodStart"
      FROM finding_feedback feedback
     WHERE feedback.observed_at < ${latestPeriodEnd}
       AND NOT EXISTS (
         SELECT 1
           FROM operator_alert_deliveries delivery
          WHERE delivery.event_key = 'finding-feedback-digest:' ||
            to_char(date_trunc('week', feedback.observed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
            AND delivery.status <> 'failed'
       )
     GROUP BY date_trunc('week', feedback.observed_at AT TIME ZONE 'UTC')
     ORDER BY date_trunc('week', feedback.observed_at AT TIME ZONE 'UTC')
     LIMIT 1
  `);
  const value = (result.rows as Array<Record<string, unknown>>)[0]?.periodStart;
  const periodStart = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value.endsWith("Z") ? value : `${value}Z`)
      : null;
  if (
    !periodStart ||
    Number.isNaN(periodStart.getTime()) ||
    periodStart.getTime() >= latestPeriodEnd.getTime()
  ) return null;
  return periodStart;
}

export function findingFeedbackDigestPeriodEnd(value: Date): Date {
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const offset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  return start;
}

export function trialStartedAlertPayload(input: {
  orgId: number;
  orgSlug: string;
  accountLogin: string;
  accountType: string;
  githubOwnerId: number;
  githubInstallationId: number;
  trialEndsAt: Date;
}): TrialStartedAlertPayload {
  return {
    event: "trial_started",
    eventKey: `trial-started:${input.githubOwnerId}`,
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    githubOwnerId: input.githubOwnerId,
    githubInstallationId: input.githubInstallationId,
    trialEndsAt: input.trialEndsAt.toISOString(),
  };
}

export function installationRemovedAlertPayload(input: {
  orgId: number;
  orgSlug: string;
  accountLogin: string;
  accountType: string;
  githubOwnerId: number;
  githubInstallationId: number;
}): InstallationRemovedAlertPayload {
  return {
    event: "installation_removed",
    eventKey: `installation-removed:${input.githubInstallationId}`,
    ...input,
  };
}

/** Transition expired trials once and queue one operator alert per transition. */
export async function sweepExpiredSelfServiceTrials(
  db: Database,
  now = new Date(),
  limit = 100,
): Promise<{ transitioned: number; alerted: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("expired trial sweep limit must be in 1..1000");
  }
  const expired = await db
    .select({
      orgId: schema.organizationEntitlements.orgId,
      trialEndsAt: schema.organizationEntitlements.trialEndsAt,
      orgSlug: schema.organizations.slug,
      accountLogin: schema.organizations.name,
      githubOwnerId: schema.organizations.githubOrgId,
    })
    .from(schema.organizationEntitlements)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.organizationEntitlements.orgId),
    )
    .where(
      and(
        eq(schema.organizationEntitlements.status, "trialing"),
        lte(schema.organizationEntitlements.trialEndsAt, now),
      ),
    )
    .orderBy(schema.organizationEntitlements.trialEndsAt)
    .limit(limit);

  let transitioned = 0;
  let alerted = 0;
  for (const row of expired) {
    if (!row.trialEndsAt) continue;
    const trialEndsAt = row.trialEndsAt;
    const result = await db.transaction(async (tx) => {
      const changed = await tx
        .update(schema.organizationEntitlements)
        .set({
          status: "past_due",
          updatedBy: "self-service-trial-expiry",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.organizationEntitlements.orgId, row.orgId),
            eq(schema.organizationEntitlements.status, "trialing"),
            lte(schema.organizationEntitlements.trialEndsAt, now),
          ),
        )
        .returning({ orgId: schema.organizationEntitlements.orgId });
      if (changed.length === 0) return { transitioned: false, alerted: false };
      if (row.githubOwnerId === null) {
        return { transitioned: true, alerted: false };
      }
      const payload: TrialExpiredAlertPayload = {
        event: "trial_expired",
        eventKey: `trial-expired:${row.orgId}:${trialEndsAt.toISOString()}`,
        orgId: row.orgId,
        orgSlug: row.orgSlug,
        accountLogin: row.accountLogin,
        githubOwnerId: row.githubOwnerId,
        trialEndsAt: trialEndsAt.toISOString(),
      };
      await enqueueCustomerNotification(
        tx,
        trialExpiredNotification({
          orgId: row.orgId,
          orgSlug: row.orgSlug,
          trialEndsAt,
        }),
        now,
      );
      return {
        transitioned: true,
        alerted: await enqueueOperatorAlert(tx, payload),
      };
    });
    if (result.transitioned) transitioned += 1;
    if (result.alerted) alerted += 1;
  }
  return { transitioned, alerted };
}

/** Restore audit consistency across retries and rolling deployments. */
export async function reconcileOperatorAlertDeliveries(
  db: Database,
): Promise<void> {
  await db.execute(sql`
    WITH recent_jobs AS MATERIALIZED (
      SELECT
        CASE
          WHEN NULLIF(jobs.payload ->> 'eventKey', '') IS NOT NULL
            THEN jobs.payload ->> 'eventKey'
          WHEN jobs.payload ->> 'event' = 'trial_started'
               AND jobs.payload ->> 'githubOwnerId' ~ '^[1-9][0-9]*$'
            THEN 'trial-started:' || (jobs.payload ->> 'githubOwnerId')
        END AS event_key,
        jobs.payload ->> 'event' AS event,
        organization.id AS org_id,
        CASE WHEN jobs.payload ->> 'githubInstallationId' ~ '^[1-9][0-9]*$'
          THEN (jobs.payload ->> 'githubInstallationId')::bigint END AS github_installation_id,
        jobs.status,
        jobs.last_error,
        jobs.created_at
      FROM jobs
      LEFT JOIN organizations AS organization
        ON organization.id = CASE WHEN jobs.payload ->> 'orgId' ~ '^[1-9][0-9]*$'
          THEN (jobs.payload ->> 'orgId')::bigint END
      WHERE jobs.kind = 'operator-alert'
      ORDER BY jobs.id DESC
      LIMIT 1000
    ), inserted AS (
      INSERT INTO operator_alert_deliveries
        (event_key, event, org_id, github_installation_id, status, created_at, updated_at)
      SELECT event_key, event, org_id, github_installation_id, 'queued', created_at, created_at
      FROM recent_jobs
      WHERE event_key IS NOT NULL
        AND event IN (
          'trial_started',
          'trial_expired',
          'installation_removed',
          'subscription_started',
          'subscription_past_due',
          'subscription_paused',
          'subscription_canceled',
          'billing_anomaly',
          'finding_feedback_digest'
        )
      ON CONFLICT (event_key) DO NOTHING
    )
    UPDATE operator_alert_deliveries AS delivery
    SET
      status = CASE WHEN job.status = 'done' THEN 'delivered' ELSE 'failed' END,
      last_error = CASE WHEN job.status = 'failed' THEN job.last_error END,
      last_attempt_at = now(),
      delivered_at = CASE
        WHEN job.status = 'done' THEN COALESCE(delivery.delivered_at, now())
        ELSE delivery.delivered_at
      END,
      updated_at = now()
    FROM recent_jobs AS job
    WHERE delivery.event_key = job.event_key
      AND (
        (job.status = 'done' AND delivery.status <> 'delivered')
        OR (job.status = 'failed' AND delivery.status IN ('queued', 'retrying'))
      )
  `);
}

/** Add the stable event key accepted by workers during a rolling deployment. */
export function normalizeLegacyOperatorAlertPayload(
  value: Record<string, unknown>,
): OperatorAlertJobPayload | null {
  if (value.event !== "trial_started") {
    return typeof value.eventKey === "string" && value.eventKey
      ? (value as unknown as OperatorAlertJobPayload)
      : null;
  }
  if (
    typeof value.githubOwnerId !== "number" ||
    !Number.isSafeInteger(value.githubOwnerId)
  ) {
    return null;
  }
  return {
    ...value,
    eventKey:
      typeof value.eventKey === "string" && value.eventKey
        ? value.eventKey
        : `trial-started:${value.githubOwnerId}`,
  } as TrialStartedAlertPayload;
}

export async function recordOperatorAlertDelivered(
  db: Database,
  payload: OperatorAlertJobPayload,
  messageId: string | null,
  now = new Date(),
): Promise<void> {
  const rows = await db
    .update(schema.operatorAlertDeliveries)
    .set({
      status: "delivered",
      messageId,
      lastError: null,
      lastAttemptAt: now,
      deliveredAt: now,
      updatedAt: now,
    })
    .where(eq(schema.operatorAlertDeliveries.eventKey, payload.eventKey))
    .returning({ eventKey: schema.operatorAlertDeliveries.eventKey });
  if (rows.length === 0) {
    throw new Error("operator alert audit row is missing");
  }
}

export async function recordOperatorAlertFailure(
  db: Database,
  payload: OperatorAlertJobPayload,
  error: string,
  terminal: boolean,
  now = new Date(),
): Promise<void> {
  await db
    .update(schema.operatorAlertDeliveries)
    .set({
      status: terminal ? "failed" : "retrying",
      lastError: error.slice(0, 2_000),
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(eq(schema.operatorAlertDeliveries.eventKey, payload.eventKey));
}
