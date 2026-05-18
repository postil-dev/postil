import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TokenUsage } from "@/jobs/run-review";

/**
 * Record a tokens_consumed usage event for a completed review.
 * Looks up the organization via the installation → organization FK.
 * Silently no-ops if the installation or org is not found.
 */
export async function recordTokenUsage(
  installationId: number,
  reviewId: string,
  usage: TokenUsage,
): Promise<void> {
  if (usage.totalTokens === 0) return;

  const db = getDb();
  const installation = await db.query.installations.findFirst({
    where: eq(schema.installations.id, installationId),
    columns: { organizationId: true },
  });
  if (!installation) return;

  await db.insert(schema.usageEvents).values({
    organizationId: installation.organizationId,
    reviewId,
    kind: "tokens_consumed",
    quantity: usage.totalTokens,
    metadata: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    },
  });
}

/**
 * Record a review_completed usage event.
 */
export async function recordReviewCompleted(
  installationId: number,
  reviewId: string,
): Promise<void> {
  const db = getDb();
  const installation = await db.query.installations.findFirst({
    where: eq(schema.installations.id, installationId),
    columns: { organizationId: true },
  });
  if (!installation) return;

  await db.insert(schema.usageEvents).values({
    organizationId: installation.organizationId,
    reviewId,
    kind: "review_completed",
    quantity: 1,
  });
}
