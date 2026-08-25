import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { DismissalReasonTag } from "@/lib/mentions";

export interface GithubFindingFeedbackReply {
  findingPublicationId: number;
  githubCommentId: number;
  body: string;
  actorGithubId: number;
  actorLogin: string;
  prAuthorGithubId: number;
  prAuthorLogin: string;
  observedAt: Date;
  sourceDeliveryId: string;
}

/** Suggest a dismissal tag from direct feedback without treating it as a decision. */
export function suggestFindingFeedbackReasonTag(
  body: string,
): DismissalReasonTag | null {
  if (
    /\b(?:false\s*positive|wrong|incorrect|not\s+(?:a\s+)?(?:problem|issue|bug))\b/iu.test(
      body,
    )
  ) {
    return "false-positive";
  }
  if (
    /\baccept(?:ed|able)?\s+(?:(?:the|this)\s+)?risk\b/iu.test(
      body,
    )
  ) {
    return "accepted-risk";
  }
  if (
    /\b(?:out(?:side)?\s+(?:of\s+)?(?:the\s+)?scope|not\s+(?:in|within)\s+(?:the\s+)?scope)\b/iu.test(
      body,
    )
  ) {
    return "out-of-scope";
  }
  return null;
}

/** Resolve a reply root to the published finding from the same pull request. */
export async function findPublishedFindingForGithubReply(
  db: Database,
  identity: {
    githubInstallationId: number;
    githubRepoId: number;
    prNumber: number;
    githubCommentId: number;
  },
): Promise<number | null> {
  const row = (
    await db
      .select({ id: schema.findingPublications.id })
      .from(schema.findingPublications)
      .innerJoin(
        schema.reviews,
        eq(schema.reviews.id, schema.findingPublications.reviewId),
      )
      .where(
        and(
          eq(
            schema.findingPublications.githubCommentId,
            String(identity.githubCommentId),
          ),
          eq(
            schema.reviews.sourceGithubInstallationId,
            identity.githubInstallationId,
          ),
          eq(schema.reviews.sourceGithubRepoId, identity.githubRepoId),
          eq(schema.reviews.prNumber, identity.prNumber),
        ),
      )
      .limit(1)
  )[0];
  return row?.id ?? null;
}

/** Persist one reply source at most once, keyed by GitHub's comment identity. */
export async function insertGithubFindingFeedbackReply(
  db: Database,
  input: GithubFindingFeedbackReply,
): Promise<boolean> {
  const rows = await db
    .insert(schema.findingFeedback)
    .values({
      findingPublicationId: input.findingPublicationId,
      source: "reply",
      sourceGithubCommentId: input.githubCommentId,
      sourceGithubReactionId: null,
      body: input.body,
      actorGithubId: input.actorGithubId,
      actorLoginSnapshot: input.actorLogin,
      prAuthorGithubId: input.prAuthorGithubId,
      prAuthorLoginSnapshot: input.prAuthorLogin,
      actorIsPrAuthor: input.actorGithubId === input.prAuthorGithubId,
      observedAt: input.observedAt,
      sourceDeliveryId: input.sourceDeliveryId,
      suggestedReasonTag: suggestFindingFeedbackReasonTag(input.body),
    })
    .onConflictDoNothing()
    .returning({ id: schema.findingFeedback.id });
  return rows.length > 0;
}
