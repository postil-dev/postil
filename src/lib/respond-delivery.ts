import { and, eq, lt, or } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";

export const RESPOND_DELIVERY_LEASE_MS = 2 * 60_000;
export const RESPOND_DELIVERY_REQUEST_TIMEOUT_MS = 30_000;

export interface RespondDelivery {
  jobId: number;
  repoFullName: string;
  issueNumber: number;
  body: string;
  state: string;
  createdAt: Date;
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
      })
      .from(schema.respondDeliveries)
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
  await db.insert(schema.respondDeliveries).values(input).onConflictDoNothing();
}

/** Claim delivery with a renewable database lease. A retry after an ambiguous
 * POST first searches GitHub for the durable marker before posting again. */
export async function claimRespondDelivery(
  db: Database,
  jobId: number,
  now = new Date(),
): Promise<RespondDelivery | null> {
  const leaseExpiresAt = new Date(now.getTime() + RESPOND_DELIVERY_LEASE_MS);
  return (
    await db
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
        repoFullName: schema.respondDeliveries.repoFullName,
        issueNumber: schema.respondDeliveries.issueNumber,
        body: schema.respondDeliveries.body,
        state: schema.respondDeliveries.state,
        createdAt: schema.respondDeliveries.createdAt,
      })
  )[0] ?? null;
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
