import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";

export interface ReviewCompletionInput {
  reviewId: number;
  envelope: Envelope;
  configFiles: string[];
  silent: boolean;
  gateFailing: boolean;
  usage: {
    orgId: number | null;
    repositoryId: number;
    promptTokens: number;
    completionTokens: number;
    modelUsed: string;
    costCents: number | null;
  };
  escalationJob?: {
    reviewPublicId: string;
    repoFullName: string;
    prNumber: number;
    runUrl: string;
  };
}

/**
 * Persist the terminal review, its accounting, and its notification outbox
 * atomically. Nothing after this transaction can make the review job retry and
 * enqueue a second escalation for the same completed review.
 */
export async function persistReviewCompletion(
  db: Database,
  input: ReviewCompletionInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.reviews)
      .set({
        status: "completed",
        envelope: input.envelope,
        configFiles: input.configFiles,
        silent: input.silent,
        engineGateFailing: input.gateFailing,
        gateFailing: input.gateFailing,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.reviews.id, input.reviewId),
          eq(schema.reviews.status, "running"),
        ),
      )
      .returning({ id: schema.reviews.id });
    if (rows.length === 0) return false;

    await tx.insert(schema.usageEvents).values({
      ...input.usage,
      reviewId: input.reviewId,
    });
    if (input.escalationJob) {
      await tx.insert(schema.jobs).values({
        kind: "escalation-notification",
        payload: {
          reviewId: input.reviewId,
          ...input.escalationJob,
        },
        maxAttempts: 5,
      });
    }
    return true;
  });
}
