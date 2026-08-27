import { lstat, readFile } from "node:fs/promises";

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  isOperationalFinding,
  type Envelope,
  type Finding,
} from "@/lib/envelope";

const MAX_RECEIPT_BYTES = 512 * 1024;
const MAX_RECEIPT_FINDINGS = 1_000;
const CARRIED_MARKER = "[carried from previous review]";
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const DECIMAL_IDENTIFIER = /^[1-9][0-9]{0,18}$/;

export const PUBLICATION_STATES = [
  "inline",
  "fileComment",
  "checkAnnotation",
  "summaryOnly",
  "carried",
  "resolved",
  "suppressed",
  "inlineRejected",
  "outdated",
  "deleted",
  "unknown",
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
export type InitialPublicationState = Exclude<PublicationState, "outdated" | "deleted">;

const receiptFindingSchema = z
  .object({
    findingId: z.string().trim().min(1).max(500),
    stableIdentity: z.boolean().default(true),
    initialOutcome: z.enum([
      "inline",
      "fileComment",
      "checkAnnotation",
      "summaryOnly",
      "carried",
      "resolved",
      "suppressed",
      "unknown",
    ]),
    inlineRejected: z.boolean().default(false),
    commentId: z.string().regex(DECIMAL_IDENTIFIER).refine(
      (value) => !DECIMAL_IDENTIFIER.test(value) || BigInt(value) <= MAX_SIGNED_INT64,
      "comment identity exceeds signed 64-bit storage",
    ).optional(),
  })
  .strict();

const publicationReceiptSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    channel: z.enum(["reviewComments", "checkAnnotations"]).optional(),
    receiptId: z.string().trim().min(1).max(200),
    reviewId: z.string().regex(DECIMAL_IDENTIFIER).refine(
      (value) => !DECIMAL_IDENTIFIER.test(value) || BigInt(value) <= MAX_SIGNED_INT64,
      "review identity exceeds signed 64-bit storage",
    ).optional(),
    findings: z.array(receiptFindingSchema).max(MAX_RECEIPT_FINDINGS),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.version === 1 && receipt.channel !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message: "version 1 receipts do not carry a publication channel",
      });
    }
    if (receipt.version === 2 && receipt.channel === undefined) {
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message: "version 2 receipts require a publication channel",
      });
    }
    if (receipt.channel === "checkAnnotations" && receipt.reviewId) {
      context.addIssue({
        code: "custom",
        path: ["reviewId"],
        message: "check annotation receipts cannot carry a review identity",
      });
    }
    const ids = new Set<string>();
    for (const [index, finding] of receipt.findings.entries()) {
      if (ids.has(finding.findingId)) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "findingId"],
          message: "duplicate finding identity",
        });
      }
      ids.add(finding.findingId);
      if (receipt.version === 1 && finding.initialOutcome === "checkAnnotation") {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "initialOutcome"],
          message: "version 1 receipts cannot report check annotations",
        });
      }
      if (receipt.version === 1 && finding.initialOutcome === "fileComment") {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "initialOutcome"],
          message: "version 1 receipts cannot report file-level comments",
        });
      }
      if (
        receipt.channel === "reviewComments" &&
        finding.initialOutcome === "checkAnnotation"
      ) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "initialOutcome"],
          message: "review comment receipts cannot report check annotations",
        });
      }
      if (
        receipt.channel === "checkAnnotations" &&
        (finding.initialOutcome === "inline" ||
          finding.initialOutcome === "fileComment")
      ) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "initialOutcome"],
          message: "check annotation receipts cannot report review comments",
        });
      }
      if (receipt.channel === "checkAnnotations" && finding.commentId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "commentId"],
          message: "check annotation receipts cannot carry comment identities",
        });
      }
      if (finding.inlineRejected && finding.initialOutcome !== "summaryOnly") {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "inlineRejected"],
          message: "rejected inline placement must use summaryOnly outcome",
        });
      }
      if (finding.initialOutcome === "fileComment" && !finding.commentId) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "commentId"],
          message: "file-level comments require a comment identity",
        });
      }
      // A carried finding is one an earlier review already published, so it
      // names that review's comment rather than one this run created. The
      // identity is what the lifecycle pass observes the thread by, so
      // withholding it here would leave those threads unobserved.
      if (
        finding.commentId &&
        finding.initialOutcome !== "inline" &&
        finding.initialOutcome !== "fileComment" &&
        finding.initialOutcome !== "carried"
      ) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "commentId"],
          message: "only a published finding can carry a comment identity",
        });
      }
    }
  });

export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

/** Validate an in-memory publication receipt against the persisted wire contract. */
export function parsePublicationReceipt(value: unknown): PublicationReceipt {
  const parsed = publicationReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`publication receipt is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function readPublicationReceipt(path: string): Promise<PublicationReceipt> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("publication receipt is not a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("publication receipt permissions are not private");
  }
  if (stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error("publication receipt size is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("publication receipt is not valid JSON");
  }
  return parsePublicationReceipt(decoded);
}

function envelopeFindingIds(envelope: Envelope): Set<string> {
  const ids = new Set<string>();
  for (const finding of [
    ...envelope.findings.filter((entry) => !isOperationalFinding(entry)),
    ...envelope.resolved,
    ...(envelope.suppressedFindings?.map((entry) => entry.finding) ?? []),
  ]) {
    if (finding.id) ids.add(finding.id);
  }
  return ids;
}

function operationalFindingIds(envelope: Envelope): Set<string> {
  return new Set(
    envelope.findings
      .filter(isOperationalFinding)
      .flatMap((finding) => (finding.id ? [finding.id] : [])),
  );
}

function envelopePublicationFindings(envelope: Envelope): Finding[] {
  return [
    ...envelope.findings.filter((entry) => !isOperationalFinding(entry)),
    ...envelope.resolved,
    ...(envelope.suppressedFindings?.map((entry) => entry.finding) ?? []),
  ];
}

function receiptPublicationFindings(
  receipt: PublicationReceipt,
  envelope: Envelope,
): PublicationReceipt["findings"] {
  // GitHub's planned receipt omits operational sentinels. The forge-neutral
  // v1 writer includes them as unknown outcomes. They describe delivery of a
  // run failure, not a user finding with a review-thread lifecycle.
  const operationalIds = operationalFindingIds(envelope);
  return receipt.findings.filter(
    (finding) => !(finding.stableIdentity && operationalIds.has(finding.findingId)),
  );
}

export function validateReceiptAgainstEnvelope(
  receipt: PublicationReceipt,
  envelope: Envelope,
): void {
  const envelopeIds = envelopeFindingIds(envelope);
  const publicationFindings = receiptPublicationFindings(receipt, envelope);
  if (publicationFindings.length !== envelopePublicationFindings(envelope).length) {
    throw new Error("publication receipt finding count does not match the review envelope");
  }
  const receiptStableIds = new Set(
    publicationFindings
      .filter((finding) => finding.stableIdentity)
      .map((finding) => finding.findingId),
  );
  for (const findingId of envelopeIds) {
    if (!receiptStableIds.has(findingId)) {
      throw new Error("publication receipt omitted a stable review finding");
    }
  }
  for (const finding of publicationFindings) {
    if (finding.stableIdentity && !envelopeIds.has(finding.findingId)) {
      throw new Error("publication receipt finding does not belong to the review envelope");
    }
  }
}

function receiptState(finding: PublicationReceipt["findings"][number]): InitialPublicationState {
  return finding.inlineRejected ? "inlineRejected" : finding.initialOutcome;
}

function legacyRows(reviewId: number, envelope: Envelope) {
  const rows: Array<{
    reviewId: number;
    findingId: string;
    stableIdentity: boolean;
    initialState: InitialPublicationState;
    currentState: PublicationState;
    githubCommentId: null;
  }> = [];
  let ordinal = 0;
  const add = (finding: Finding | undefined) => {
    rows.push({
      reviewId,
      findingId: finding?.id ?? `legacy-unobserved:${reviewId}:${ordinal}`,
      stableIdentity: Boolean(finding?.id),
      initialState: "unknown",
      currentState: "unknown",
      githubCommentId: null,
    });
    ordinal += 1;
  };
  envelope.findings
    .filter((finding) => !isOperationalFinding(finding))
    .forEach(add);
  envelope.resolved.forEach(add);
  envelope.suppressedFindings?.forEach((entry) => add(entry.finding));
  const retainedSuppressed = envelope.suppressedFindings?.length ?? 0;
  for (let index = retainedSuppressed; index < envelope.counts.suppressed; index += 1) add(undefined);
  return rows;
}

/** Persist one immutable receipt and reconcile the same stable findings in prior reviews. */
export async function persistPublicationReceipt(
  tx: Database,
  input: { reviewId: number; envelope: Envelope; receipt?: PublicationReceipt },
): Promise<void> {
  const review = (
    await tx
      .select({ repositoryId: schema.reviews.repositoryId, prNumber: schema.reviews.prNumber })
      .from(schema.reviews)
      .where(eq(schema.reviews.id, input.reviewId))
      .limit(1)
  )[0];
  if (!review) throw new Error("review not found for publication receipt");

  if (input.receipt) validateReceiptAgainstEnvelope(input.receipt, input.envelope);
  await tx.insert(schema.reviewPublicationReceipts).values({
    reviewId: input.reviewId,
    receiptVersion: input.receipt?.version ?? null,
    receiptId: input.receipt?.receiptId ?? null,
    publicationChannel:
      input.receipt?.version === 1
        ? "reviewComments"
        : (input.receipt?.channel ?? null),
    githubReviewId: input.receipt?.reviewId ?? null,
  });

  const rows = input.receipt
    ? receiptPublicationFindings(input.receipt, input.envelope).map((finding) => {
        const state = receiptState(finding);
        return {
          reviewId: input.reviewId,
          findingId: finding.findingId,
          stableIdentity: finding.stableIdentity,
          initialState: state,
          currentState: state,
          githubCommentId: finding.commentId ?? null,
        };
      })
    : legacyRows(input.reviewId, input.envelope);
  if (rows.length > 0) await tx.insert(schema.findingPublications).values(rows);

  const transitions = new Map<string, PublicationState>();
  for (const finding of input.envelope.findings) {
    if (!finding.id || isOperationalFinding(finding)) continue;
    if (finding.body.startsWith(CARRIED_MARKER)) transitions.set(finding.id, "carried");
  }
  for (const finding of input.envelope.resolved) {
    if (finding.id) transitions.set(finding.id, "resolved");
  }
  for (const entry of input.envelope.suppressedFindings ?? []) {
    if (entry.finding.id) transitions.set(entry.finding.id, "suppressed");
  }
  for (const currentState of ["carried", "resolved", "suppressed"] as const) {
    const findingIds = [...transitions]
      .filter(([, state]) => state === currentState)
      .map(([findingId]) => findingId);
    if (findingIds.length === 0) continue;
    await tx
      .update(schema.findingPublications)
      .set({ currentState, lifecycleObservedAt: new Date() })
      .where(
        and(
          inArray(schema.findingPublications.findingId, findingIds),
          eq(schema.findingPublications.stableIdentity, true),
          ne(schema.findingPublications.reviewId, input.reviewId),
          sql`${schema.findingPublications.reviewId} IN (
            SELECT prior.id FROM reviews prior
            WHERE prior.repository_id = ${review.repositoryId}
              AND prior.pr_number = ${review.prNumber}
          )`,
        ),
      );
  }
}

export interface PublicationThreadObservation {
  githubCommentId: string;
  githubThreadId?: string;
  state: "inline" | "resolved" | "outdated" | "deleted";
}

/** Apply only forge-observed thread state; human prose and review dismissal are not inputs. */
export async function applyPublicationThreadObservations(
  db: Database,
  observations: PublicationThreadObservation[],
): Promise<void> {
  if (observations.length === 0) return;
  const ids = observations.map((entry) => entry.githubCommentId);
  const known = await db
    .select({ id: schema.findingPublications.id, githubCommentId: schema.findingPublications.githubCommentId })
    .from(schema.findingPublications)
    .where(inArray(schema.findingPublications.githubCommentId, ids));
  const rowIds = new Map(known.map((row) => [row.githubCommentId, row.id]));
  for (const observation of observations) {
    const id = rowIds.get(observation.githubCommentId);
    if (id === undefined) continue;
    const update = observation.state === "inline"
      ? { lifecycleObservedAt: new Date() }
      : { currentState: observation.state, lifecycleObservedAt: new Date() };
    await db
      .update(schema.findingPublications)
      .set(update)
      .where(eq(schema.findingPublications.id, id));
  }
}

export interface PullRequestPublicationThreadPlan {
  commentIds: string[];
  resolveCommentIds: string[];
}

/** Load every owned thread plus the subset whose finding is no longer active. */
export async function getPullRequestPublicationThreadPlan(
  db: Database,
  repositoryId: number,
  prNumber: number,
): Promise<PullRequestPublicationThreadPlan> {
  const rows = await db
    .select({
      reviewId: schema.findingPublications.reviewId,
      findingId: schema.findingPublications.findingId,
      stableIdentity: schema.findingPublications.stableIdentity,
      githubCommentId: schema.findingPublications.githubCommentId,
      currentState: schema.findingPublications.currentState,
      reviewStatus: schema.reviews.status,
      queuedAt: schema.reviews.queuedAt,
    })
    .from(schema.findingPublications)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.findingPublications.reviewId))
    .where(
      and(
        eq(schema.reviews.repositoryId, repositoryId),
        eq(schema.reviews.prNumber, prNumber),
      ),
    );
  const commentIds = new Set<string>();
  const resolveCommentIds = new Set<string>();
  // Forge observations can move the published comment row to outdated or
  // deleted. Resolve from the newest stable occurrence of the finding: a
  // later terminal receipt row has no comment identity, while a still later
  // active recurrence must supersede that terminal state.
  const latestStableState = new Map<
    string,
    {
      reviewId: number;
      queuedAt: Date;
      currentState: PublicationState;
      reviewStatus: (typeof schema.reviews.status.enumValues)[number];
    }
  >();
  for (const row of rows) {
    if (!row.stableIdentity) continue;
    const latest = latestStableState.get(row.findingId);
    if (
      !latest ||
      row.queuedAt > latest.queuedAt ||
      (row.queuedAt.getTime() === latest.queuedAt.getTime() &&
        row.reviewId > latest.reviewId)
    ) {
      latestStableState.set(row.findingId, {
        reviewId: row.reviewId,
        queuedAt: row.queuedAt,
        currentState: row.currentState as PublicationState,
        reviewStatus: row.reviewStatus,
      });
    }
  }
  const terminalFindingIds = new Set(
    [...latestStableState]
      .filter(
        ([, row]) =>
          row.reviewStatus === "completed" &&
          (row.currentState === "resolved" || row.currentState === "suppressed"),
      )
      .map(([findingId]) => findingId),
  );
  for (const row of rows) {
    if (!row.githubCommentId) continue;
    commentIds.add(row.githubCommentId);
    if (row.stableIdentity && terminalFindingIds.has(row.findingId)) {
      resolveCommentIds.add(row.githubCommentId);
    }
  }
  return {
    commentIds: [...commentIds].sort(),
    resolveCommentIds: [...resolveCommentIds].sort(),
  };
}

export interface PublicationCounts {
  inline: number;
  fileComment: number;
  checkAnnotation: number;
  summaryOnly: number;
  carried: number;
  resolved: number;
  suppressed: number;
  inlineRejected: number;
  outdated: number;
  deleted: number;
  unknown: number;
}

export function emptyPublicationCounts(): PublicationCounts {
  return Object.fromEntries(PUBLICATION_STATES.map((state) => [state, 0])) as unknown as PublicationCounts;
}

export async function getReviewPublicationCounts(
  db: Database,
  reviewIds: number[],
): Promise<Map<number, PublicationCounts>> {
  if (reviewIds.length === 0) return new Map();
  const rows = await db
    .select({
      reviewId: schema.findingPublications.reviewId,
      currentState: schema.findingPublications.currentState,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.findingPublications)
    .where(inArray(schema.findingPublications.reviewId, reviewIds))
    .groupBy(schema.findingPublications.reviewId, schema.findingPublications.currentState);
  const result = new Map<number, PublicationCounts>();
  for (const row of rows) {
    const counts = result.get(row.reviewId) ?? emptyPublicationCounts();
    if ((PUBLICATION_STATES as readonly string[]).includes(row.currentState)) {
      counts[row.currentState as PublicationState] = row.count;
    }
    result.set(row.reviewId, counts);
  }
  return result;
}
