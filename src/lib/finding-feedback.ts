import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { verifyLiveGithubAdmin } from "@/lib/github/approval-actor";
import {
  listPullRequestReviewCommentReactions,
} from "@/lib/github/checks";
import type { DismissalReasonTag } from "@/lib/mentions";
import { redactAndTruncate } from "@/lib/redact";

const MAX_RECONCILIATIONS_PER_RUN = 200;
const RECENT_PUBLICATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const RETRY_INTERVAL_MS = 5 * 60 * 1_000;
const RECONCILIATION_DEADLINE_MS = 45_000;
const MAX_UNIQUE_REACTION_ACTORS = 24;
const MAX_CONCURRENT_ADMIN_VERIFICATIONS = 6;

export const GITHUB_REACTION_CONTENTS = [
  "+1",
  "-1",
] as const;

export type GithubReactionContent = (typeof GITHUB_REACTION_CONTENTS)[number];

class FindingFeedbackReconciliationUnavailableError extends Error {
  constructor() {
    super("GitHub feedback authorization is unavailable");
    this.name = "FindingFeedbackReconciliationUnavailableError";
  }
}

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

export interface GithubFindingFeedbackReaction {
  findingPublicationId: number;
  githubCommentId: number;
  githubReactionId: number;
  content: GithubReactionContent;
  actorGithubId: number;
  actorLogin: string;
  prAuthorGithubId: number;
  prAuthorLogin: string;
  observedAt: Date;
}

export interface FindingFeedbackAggregate {
  source: "reply" | "reaction";
  suggestedReasonTag: DismissalReasonTag | null;
  reactionContent: GithubReactionContent | null;
  model: string | null;
  kind: string | null;
  severity: string | null;
  count: number;
}

function isGithubLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
}

function isGithubReactionContent(value: string): value is GithubReactionContent {
  return (GITHUB_REACTION_CONTENTS as readonly string[]).includes(value);
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

/** Insert one immutable reaction source at most once by GitHub reaction id. */
export async function insertGithubFindingFeedbackReaction(
  db: Database,
  input: GithubFindingFeedbackReaction,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.githubCommentId) ||
    !Number.isSafeInteger(input.githubReactionId) ||
    !Number.isSafeInteger(input.actorGithubId) ||
    !Number.isSafeInteger(input.prAuthorGithubId) ||
    input.githubCommentId <= 0 ||
    input.githubReactionId <= 0 ||
    input.actorGithubId <= 0 ||
    input.prAuthorGithubId <= 0 ||
    !isGithubLogin(input.actorLogin) ||
    !isGithubLogin(input.prAuthorLogin) ||
    !isGithubReactionContent(input.content) ||
    Number.isNaN(input.observedAt.getTime())
  ) {
    throw new Error("GitHub finding feedback reaction is malformed");
  }
  const rows = await db
    .insert(schema.findingFeedback)
    .values({
      findingPublicationId: input.findingPublicationId,
      source: "reaction",
      sourceGithubCommentId: input.githubCommentId,
      sourceGithubReactionId: input.githubReactionId,
      reactionContent: input.content,
      body: null,
      actorGithubId: input.actorGithubId,
      actorLoginSnapshot: input.actorLogin,
      prAuthorGithubId: input.prAuthorGithubId,
      prAuthorLoginSnapshot: input.prAuthorLogin,
      actorIsPrAuthor: input.actorGithubId === input.prAuthorGithubId,
      observedAt: input.observedAt,
      sourceDeliveryId: null,
      suggestedReasonTag: null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.findingFeedback.id });
  return rows.length > 0;
}

/** Queue at most 200 due, recent published comments without touching review lifecycle state. */
export async function scheduleFindingFeedbackReconciliationJobs(
  pool: Pick<Pool, "query">,
  now = new Date(),
  requiredSuccessfulAt?: Date,
): Promise<number> {
  const recentCutoff = new Date(now.getTime() - RECENT_PUBLICATION_WINDOW_MS);
  const result = await pool.query<{ id: string }>(
    `WITH due AS MATERIALIZED (
       SELECT publication.id
         FROM finding_publications publication
         JOIN reviews review ON review.id = publication.review_id
         LEFT JOIN finding_feedback_reconciliations reconciliation
           ON reconciliation.finding_publication_id = publication.id
        WHERE publication.github_comment_id IS NOT NULL
          AND publication.current_state <> 'deleted'
          AND review.status = 'completed'
          AND review.finished_at >= $1
          AND (
            COALESCE(reconciliation.next_reconcile_at, $2::timestamptz) <= $2::timestamptz
            OR reconciliation.last_successful_at IS NULL
            OR ($3::timestamptz IS NOT NULL AND reconciliation.last_successful_at < $3::timestamptz)
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs
             WHERE kind = 'finding-feedback-reconciliation'
               AND status IN ('queued', 'running')
               AND payload->>'findingPublicationId' = publication.id::text
          )
        ORDER BY COALESCE(reconciliation.next_reconcile_at, review.finished_at), publication.id
        FOR UPDATE OF publication SKIP LOCKED
        LIMIT ${MAX_RECONCILIATIONS_PER_RUN}
     ), state AS (
       INSERT INTO finding_feedback_reconciliations (finding_publication_id, next_reconcile_at)
       SELECT id, $2::timestamptz FROM due
       ON CONFLICT (finding_publication_id) DO NOTHING
     )
     INSERT INTO jobs (kind, payload, status, run_after, max_attempts)
     SELECT 'finding-feedback-reconciliation',
            jsonb_build_object('findingPublicationId', id),
            'queued', $2::timestamptz, 5
       FROM due
     RETURNING id`,
    [recentCutoff, now, requiredSuccessfulAt ?? null],
  );
  return result.rowCount ?? 0;
}

/** True once every in-window, non-deleted publication was observed after a cutoff. */
export async function findingFeedbackReconciliationWatermarkReached(
  db: Database,
  cutoff: Date,
): Promise<boolean> {
  const windowStart = new Date(cutoff.getTime() - RECENT_PUBLICATION_WINDOW_MS);
  const rows = await db.execute(sql`
    SELECT 1
      FROM finding_publications publication
      JOIN reviews review ON review.id = publication.review_id
      LEFT JOIN finding_feedback_reconciliations reconciliation
        ON reconciliation.finding_publication_id = publication.id
     WHERE publication.github_comment_id IS NOT NULL
       AND publication.current_state <> 'deleted'
       AND review.status = 'completed'
       AND review.finished_at >= ${windowStart}
       AND (reconciliation.last_successful_at IS NULL OR reconciliation.last_successful_at < ${cutoff})
     LIMIT 1
  `);
  return (rows as unknown as Array<unknown>).length === 0;
}

/** Load privacy-safe feedback aggregates without reply prose or actor identity. */
export async function findingFeedbackAggregates(
  db: Database,
  periodStart: Date,
  periodEnd: Date,
  limit = 20,
): Promise<FindingFeedbackAggregate[]> {
  if (limit < 1 || limit > 20) throw new Error("feedback aggregate limit must be in 1..20");
  const rows = await db.execute(sql`
    SELECT feedback.source,
           feedback.suggested_reason_tag AS "suggestedReasonTag",
           feedback.reaction_content AS "reactionContent",
           review.envelope->>'modelUsed' AS model,
           finding.value->>'kind' AS kind,
           finding.value->>'severity' AS severity,
           count(*)::int AS count
      FROM finding_feedback feedback
      JOIN finding_publications publication ON publication.id = feedback.finding_publication_id
      JOIN reviews review ON review.id = publication.review_id
      LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(review.envelope->'findings') = 'array'
          THEN review.envelope->'findings' ELSE '[]'::jsonb END
      ) AS finding(value) ON finding.value->>'id' = publication.finding_id
     WHERE feedback.observed_at >= ${periodStart}
       AND feedback.observed_at < ${periodEnd}
     GROUP BY feedback.source, feedback.suggested_reason_tag, feedback.reaction_content,
              review.envelope->>'modelUsed', finding.value->>'kind', finding.value->>'severity'
     ORDER BY count(*) DESC, feedback.source, feedback.reaction_content NULLS FIRST,
              feedback.suggested_reason_tag NULLS FIRST, model NULLS FIRST,
              kind NULLS FIRST, severity NULLS FIRST
     LIMIT ${limit}
  `);
  return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
    source: row.source === "reaction" ? "reaction" : "reply",
    suggestedReasonTag:
      row.suggestedReasonTag === "false-positive" ||
      row.suggestedReasonTag === "accepted-risk" ||
      row.suggestedReasonTag === "out-of-scope"
        ? row.suggestedReasonTag
        : null,
    reactionContent:
      typeof row.reactionContent === "string" && isGithubReactionContent(row.reactionContent)
        ? row.reactionContent
        : null,
    model: typeof row.model === "string" ? row.model : null,
    kind: typeof row.kind === "string" ? row.kind : null,
    severity: typeof row.severity === "string" ? row.severity : null,
    count: Number(row.count),
  }));
}

/** Re-read one published review comment and record eligible reactions without lifecycle mutation. */
export async function reconcileFindingFeedbackReactions(
  db: Database,
  findingPublicationId: number,
  now = new Date(),
): Promise<{ captured: number }> {
  if (!Number.isSafeInteger(findingPublicationId) || findingPublicationId <= 0) {
    throw new Error("finding feedback reconciliation payload is malformed");
  }
  const row = (await db.select({
    findingPublicationId: schema.findingPublications.id,
    githubCommentId: schema.findingPublications.githubCommentId,
    repoFullName: schema.repositories.fullName,
    installationId: schema.installations.githubInstallationId,
    installationAccountType: schema.installations.accountType,
    orgId: schema.installations.orgId,
    prAuthorGithubId: schema.reviews.authorGithubId,
    prAuthorLogin: schema.reviews.authorLogin,
  }).from(schema.findingPublications)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.findingPublications.reviewId))
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .innerJoin(schema.installations, eq(schema.installations.id, schema.repositories.installationId))
    .where(and(eq(schema.findingPublications.id, findingPublicationId), eq(schema.reviews.status, "completed")))
    .limit(1))[0];
  const githubCommentId = row?.githubCommentId == null ? Number.NaN : Number(row.githubCommentId);
  if (!row || !row.githubCommentId || !/^[1-9][0-9]{0,19}$/u.test(row.githubCommentId) ||
      !Number.isSafeInteger(githubCommentId) || githubCommentId <= 0 ||
      !Number.isSafeInteger(row.installationId) || row.installationId <= 0 ||
      !Number.isSafeInteger(row.orgId) || row.orgId == null || row.orgId <= 0 ||
      !Number.isSafeInteger(row.prAuthorGithubId) || row.prAuthorGithubId == null || row.prAuthorGithubId <= 0 ||
      typeof row.prAuthorLogin !== "string" || !isGithubLogin(row.prAuthorLogin)) {
    throw new Error("published finding feedback reconciliation identity is unavailable");
  }
  const orgId = row.orgId;
  await db.insert(schema.findingFeedbackReconciliations).values({
    findingPublicationId,
    attemptCount: 0,
    nextReconcileAt: now,
  }).onConflictDoNothing();
  await db.update(schema.findingFeedbackReconciliations).set({
    attemptCount: sql`${schema.findingFeedbackReconciliations.attemptCount} + 1`,
    lastAttemptAt: now,
    lastError: null,
    updatedAt: now,
  }).where(eq(schema.findingFeedbackReconciliations.findingPublicationId, findingPublicationId));
  try {
    const deadline = AbortSignal.timeout(RECONCILIATION_DEADLINE_MS);
    const token = await getInstallationToken(row.installationId, deadline);
    const reactions = await listPullRequestReviewCommentReactions(
      token,
      row.repoFullName,
      githubCommentId,
      deadline,
    );
    let captured = 0;
    const eligibleReactions = reactions.filter((reaction) =>
      reaction.user.type !== "Bot" && !reaction.user.login.endsWith("[bot]"),
    );
    const adminActors = new Map<string, typeof eligibleReactions[number]["user"]>();
    for (const reaction of eligibleReactions) {
      if (reaction.user.id !== row.prAuthorGithubId) {
        adminActors.set(`${reaction.user.id}:${reaction.user.login.toLowerCase()}`, reaction.user);
      }
    }
    if (adminActors.size > MAX_UNIQUE_REACTION_ACTORS) {
      throw new FindingFeedbackReconciliationUnavailableError();
    }
    const eligible = new Map<string, boolean>();
    await boundedMap(
      [...adminActors.entries()],
      MAX_CONCURRENT_ADMIN_VERIFICATIONS,
      async ([cacheKey, actor]) => {
        const verification = await verifyLiveGithubAdmin({
          orgId,
          installationAccountType: row.installationAccountType,
        }, actor, row.repoFullName, token, deadline);
        if (verification.outcome === "unavailable") {
          throw new FindingFeedbackReconciliationUnavailableError();
        }
        eligible.set(cacheKey, verification.outcome === "authorized");
      },
    );
    for (const reaction of eligibleReactions) {
      const isAuthor = reaction.user.id === row.prAuthorGithubId;
      const cacheKey = `${reaction.user.id}:${reaction.user.login.toLowerCase()}`;
      const allowed = isAuthor || eligible.get(cacheKey) === true;
      if (!allowed) continue;
      if (await insertGithubFindingFeedbackReaction(db, {
        findingPublicationId,
        githubCommentId,
        githubReactionId: reaction.id,
        content: reaction.content,
        actorGithubId: reaction.user.id,
        actorLogin: reaction.user.login,
        prAuthorGithubId: row.prAuthorGithubId,
        prAuthorLogin: row.prAuthorLogin,
        observedAt: reaction.createdAt,
      })) captured += 1;
    }
    await db.update(schema.findingFeedbackReconciliations).set({
      nextReconcileAt: new Date(now.getTime() + RECONCILIATION_INTERVAL_MS),
      lastSuccessfulAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(schema.findingFeedbackReconciliations.findingPublicationId, findingPublicationId));
    return { captured };
  } catch (error) {
    await db.update(schema.findingFeedbackReconciliations).set({
      nextReconcileAt: new Date(now.getTime() + RETRY_INTERVAL_MS),
      lastError: redactAndTruncate(error, 2_000),
      updatedAt: now,
    }).where(eq(schema.findingFeedbackReconciliations.findingPublicationId, findingPublicationId));
    throw error;
  }
}

async function boundedMap<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const value = values[next];
      next += 1;
      if (value !== undefined) await operation(value);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
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
