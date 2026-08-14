import { lstat, readFile } from "node:fs/promises";

import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
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

export interface FindingPublicationCommentBinding {
  findingId: string;
  githubCommentId: string | null;
}

/** A GitHub comment may be retained historically, but only for one finding. */
export function assertOneFindingPerGithubComment(
  bindings: readonly FindingPublicationCommentBinding[],
): void {
  const findingByComment = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.githubCommentId === null) continue;
    const existingFindingId = findingByComment.get(binding.githubCommentId);
    if (
      existingFindingId !== undefined &&
      existingFindingId !== binding.findingId
    ) {
      throw new Error(
        "GitHub publication comment identity belongs to multiple findings",
      );
    }
    findingByComment.set(binding.githubCommentId, binding.findingId);
  }
}

/** Resolve the newest reply binding after proving historical rows are unambiguous. */
export function resolveFindingPublicationBinding<
  T extends FindingPublicationCommentBinding,
>(bindingsNewestFirst: readonly T[]): T | null {
  assertOneFindingPerGithubComment(bindingsNewestFirst);
  return bindingsNewestFirst[0] ?? null;
}

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
    commentId: z.string().regex(/^[1-9][0-9]{0,19}$/).optional(),
  })
  .strict();

const publicationReceiptSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    channel: z.enum(["reviewComments", "checkAnnotations"]).optional(),
    receiptId: z.string().trim().min(1).max(200),
    reviewId: z.string().regex(/^[1-9][0-9]{0,19}$/).optional(),
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
    const commentIds = new Set<string>();
    for (const [index, finding] of receipt.findings.entries()) {
      if (ids.has(finding.findingId)) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "findingId"],
          message: "duplicate finding identity",
        });
      }
      ids.add(finding.findingId);
      if (finding.commentId && commentIds.has(finding.commentId)) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "commentId"],
          message: "duplicate GitHub comment identity",
        });
      }
      if (finding.commentId) commentIds.add(finding.commentId);
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
      if (
        finding.commentId &&
        finding.initialOutcome !== "inline" &&
        finding.initialOutcome !== "fileComment"
      ) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "commentId"],
          message: "only review-comment findings can carry a comment identity",
        });
      }
    }
  });

export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

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
  const parsed = publicationReceiptSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`publication receipt is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
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
  assertOneFindingPerGithubComment(
    publicationFindings.map((finding) => ({
      findingId: finding.findingId,
      githubCommentId: finding.commentId ?? null,
    })),
  );
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
  state: "inline" | "resolved" | "outdated" | "deleted";
  /** True only when GitHub currently proves the resolver has write-level repository authority. */
  resolutionAuthorized?: boolean;
  /** Live resolver identity when GitHub supplies one. */
  resolvedByGithubId?: number;
  resolvedByLogin?: string;
}

export interface PublicationThreadObservationBinding {
  reviewId: number;
  findingId: string;
  githubCommentId: string;
}

function normalizePublicationThreadObservations(
  observations: PublicationThreadObservation[],
): PublicationThreadObservation[] {
  const observationsByComment = new Map<string, PublicationThreadObservation>();
  for (const observation of observations) {
    const existing = observationsByComment.get(observation.githubCommentId);
    if (existing !== undefined && (
      existing.state !== observation.state ||
      existing.resolutionAuthorized !== observation.resolutionAuthorized ||
      existing.resolvedByGithubId !== observation.resolvedByGithubId ||
      existing.resolvedByLogin !== observation.resolvedByLogin
    )) {
      throw new Error("conflicting GitHub publication thread observations");
    }
    if (existing === undefined) {
      observationsByComment.set(observation.githubCommentId, observation);
    }
  }
  return [...observationsByComment.values()];
}

/** Persist the resolver provenance for every resolved forge observation. */
export async function recordPublicationThreadObservations(
  db: Database,
  input: {
    sourceDeliveryId: string;
    bindings: PublicationThreadObservationBinding[];
    observations: PublicationThreadObservation[];
  },
): Promise<void> {
  const sourceDeliveryId = input.sourceDeliveryId.trim();
  if (sourceDeliveryId.length === 0 || sourceDeliveryId.length > 200) {
    throw new Error("publication lifecycle observation source identity is invalid");
  }
  assertOneFindingPerGithubComment(input.bindings);
  const observations = normalizePublicationThreadObservations(input.observations);
  const observationsByComment = new Map(
    observations.map((observation) => [observation.githubCommentId, observation]),
  );
  const rows = input.bindings.flatMap((binding) => {
    const observation = observationsByComment.get(binding.githubCommentId);
    if (observation?.state !== "resolved") return [];
    return [{
      sourceDeliveryId,
      webhookAction: "resolved",
      reviewId: binding.reviewId,
      findingId: binding.findingId,
      githubCommentId: binding.githubCommentId,
      observedState: observation.state,
      resolverGithubId: observation.resolvedByGithubId === undefined
        ? null
        : String(observation.resolvedByGithubId),
      resolverLogin: observation.resolvedByLogin ?? null,
      resolutionAuthorized: observation.resolutionAuthorized === true,
      forgeObservedAt: new Date(),
    }];
  });
  if (rows.length === 0) return;
  await db
    .insert(schema.findingLifecycleObservations)
    .values(rows)
    .onConflictDoNothing();
}

/** Apply only forge-observed thread state; human prose and review dismissal are not inputs. */
export async function applyPublicationThreadObservations(
  db: Database,
  observations: PublicationThreadObservation[],
): Promise<void> {
  if (observations.length === 0) return;
  for (const observation of normalizePublicationThreadObservations(observations)) {
    const update = observation.state === "inline" ||
        (observation.state === "resolved" && observation.resolutionAuthorized !== true)
      ? { lifecycleObservedAt: new Date() }
      : { currentState: observation.state, lifecycleObservedAt: new Date() };
    await db
      .update(schema.findingPublications)
      .set(update)
      .where(eq(
        schema.findingPublications.githubCommentId,
        observation.githubCommentId,
      ));
  }
}

/** Record resolver provenance and apply forge state in one database transaction. */
export async function reconcilePublicationThreadObservations(
  db: Database,
  sourceDeliveryId: string,
  observations: PublicationThreadObservation[],
): Promise<void> {
  const normalized = normalizePublicationThreadObservations(observations);
  const resolvedCommentIds = normalized.flatMap((observation) =>
    observation.state === "resolved" ? [observation.githubCommentId] : []
  );
  let bindings: PublicationThreadObservationBinding[] = [];
  if (resolvedCommentIds.length > 0) {
    bindings = await db
      .selectDistinctOn([schema.findingPublications.githubCommentId], {
        reviewId: schema.findingPublications.reviewId,
        findingId: schema.findingPublications.findingId,
        githubCommentId: schema.findingPublications.githubCommentId,
      })
      .from(schema.findingPublications)
      .where(
        and(
          eq(schema.findingPublications.stableIdentity, true),
          isNotNull(schema.findingPublications.githubCommentId),
          inArray(schema.findingPublications.githubCommentId, resolvedCommentIds),
        ),
      )
      .orderBy(
        schema.findingPublications.githubCommentId,
        desc(schema.findingPublications.id),
      ) as PublicationThreadObservationBinding[];
    const boundCommentIds = new Set(bindings.map((binding) => binding.githubCommentId));
    if (resolvedCommentIds.some((commentId) => !boundCommentIds.has(commentId))) {
      throw new Error("resolved GitHub publication thread has no durable finding binding");
    }
  }
  await db.transaction(async (tx) => {
    await recordPublicationThreadObservations(tx, {
      sourceDeliveryId,
      bindings,
      observations: normalized,
    });
    await applyPublicationThreadObservations(tx, normalized);
  });
}

export async function getPullRequestPublicationCommentIds(
  db: Database,
  repositoryId: number,
  prNumber: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ githubCommentId: schema.findingPublications.githubCommentId })
    .from(schema.findingPublications)
    .innerJoin(schema.reviews, eq(schema.reviews.id, schema.findingPublications.reviewId))
    .where(
      and(
        eq(schema.reviews.repositoryId, repositoryId),
        eq(schema.reviews.prNumber, prNumber),
        eq(schema.findingPublications.stableIdentity, true),
        sql`${schema.findingPublications.githubCommentId} IS NOT NULL`,
      ),
    );
  return rows.flatMap((row) => (row.githubCommentId ? [row.githubCommentId] : []));
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
