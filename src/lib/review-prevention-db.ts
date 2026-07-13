import { and, desc, eq, isNotNull } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { parsedPriorReviewsWarrantPreventionHint } from "@/lib/review-prevention";

/** Load the two latest completed reviews before the current review is inserted. */
export async function shouldSendPreventionHint(
  db: Database,
  repositoryId: number,
  prNumber: number,
): Promise<boolean> {
  const rows = await db
    .select({ envelope: schema.reviews.envelope })
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.repositoryId, repositoryId),
        eq(schema.reviews.prNumber, prNumber),
        eq(schema.reviews.status, "completed"),
        isNotNull(schema.reviews.envelope),
      ),
    )
    .orderBy(desc(schema.reviews.finishedAt), desc(schema.reviews.id))
    .limit(2);

  return parsedPriorReviewsWarrantPreventionHint(rows.map((row) => row.envelope));
}
