import { and, eq, lt, or, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export const RESPOND_DELIVERY_LEASE_MS = 2 * 60_000;
export const RESPOND_DELIVERY_REQUEST_TIMEOUT_MS = 30_000;
export const RESPOND_DELIVERY_MAX_ATTEMPTS = 2_147_483_647;

export interface RespondDelivery {
  jobId: number;
  repoFullName: string;
  issueNumber: number;
  body: string;
  state: string;
  createdAt: Date;
  githubInstallationId: number;
}

export async function getRespondDelivery(
  db: Database,
  jobId: number,
): Promise<RespondDelivery | null> {
  return (
    await db
      .select({
        jobId: schema.respondDeliveries.jobId,
        repoFullName: schema.respondDeliveries.repoFullName,
        issueNumber: schema.respondDeliveries.issueNumber,
        body: schema.respondDeliveries.body,
        state: schema.respondDeliveries.state,
        createdAt: schema.respondDeliveries.createdAt,
        githubInstallationId: schema.installations.githubInstallationId,
      })
      .from(schema.respondDeliveries)
      .innerJoin(
        schema.repositories,
        eq(schema.repositories.id, schema.respondDeliveries.repositoryId),
      )
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(eq(schema.respondDeliveries.jobId, jobId))
      .limit(1)
  )[0] ?? null;
}

export async function prepareUnmeteredRespondDelivery(
  db: Database,
  input: {
    jobId: number;
    repositoryId: number;
    repoFullName: string;
    issueNumber: number;
    body: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.respondDeliveries)
      .values(input)
      .onConflictDoNothing()
      .returning({ jobId: schema.respondDeliveries.jobId });
    if (inserted.length > 0) {
      await enqueueRespondDeliveryJob(tx, input.jobId);
    }
  });
}

export async function enqueueRespondDeliveryJob(
  db: Database,
  respondJobId: number,
): Promise<void> {
  await db.insert(schema.jobs).values({
    kind: "respond-delivery",
    payload: { respondJobId },
    maxAttempts: RESPOND_DELIVERY_MAX_ATTEMPTS,
  });
}

/** Repair deliveries created before independent delivery jobs existed. */
export async function recoverRespondDeliveryJobs(db: Database): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO "jobs" ("kind", "payload", "status", "max_attempts")
    SELECT
      'respond-delivery',
      jsonb_build_object('respondJobId', delivery."job_id"),
      'queued',
      ${RESPOND_DELIVERY_MAX_ATTEMPTS}
    FROM "respond_deliveries" delivery
    WHERE delivery."state" <> 'delivered'
      AND NOT EXISTS (
        SELECT 1
        FROM "jobs" job
        WHERE job."kind" = 'respond-delivery'
          AND job."payload" @> jsonb_build_object('respondJobId', delivery."job_id")
      )
    RETURNING "id"
  `);
  return result.rows.length;
}

/** Claim delivery with a renewable database lease. A retry after an ambiguous
 * POST first searches GitHub for the durable marker before posting again. */
export async function claimRespondDelivery(
  db: Database,
  jobId: number,
  now = new Date(),
): Promise<RespondDelivery | null> {
  const leaseExpiresAt = new Date(now.getTime() + RESPOND_DELIVERY_LEASE_MS);
  const claimed = await db
      .update(schema.respondDeliveries)
      .set({ state: "delivering", deliveryLeaseExpiresAt: leaseExpiresAt, updatedAt: now })
      .where(
        and(
          eq(schema.respondDeliveries.jobId, jobId),
          or(
            eq(schema.respondDeliveries.state, "prepared"),
            and(
              eq(schema.respondDeliveries.state, "delivering"),
              lt(schema.respondDeliveries.deliveryLeaseExpiresAt, now),
            ),
          ),
        ),
      )
      .returning({
        jobId: schema.respondDeliveries.jobId,
      });
  return claimed.length > 0 ? getRespondDelivery(db, jobId) : null;
}

export async function markRespondDelivered(
  db: Database,
  jobId: number,
  githubCommentId: number,
  now = new Date(),
): Promise<void> {
  await db
    .update(schema.respondDeliveries)
    .set({
      state: "delivered",
      githubCommentId,
      deliveredAt: now,
      deliveryLeaseExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(schema.respondDeliveries.jobId, jobId));
}

export function respondDeliveryMarker(jobId: number): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("respond job id is invalid");
  return `<!-- postil-respond-job:${jobId} -->`;
}
