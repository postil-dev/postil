import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  computeEffectiveGate,
  envelopeSchema,
  findingStableId,
  isOperationalFinding,
  qualifiesHumanEscalation,
  type EffectiveGateState,
  type Envelope,
  type Finding,
} from "@/lib/envelope";
import type { DismissalReasonTag } from "@/lib/mentions";

export interface ApprovalRow {
  id: string;
  reviewId: number;
  findingId: string;
  actorUserId: number;
  actorGithubId: string;
  actorLoginSnapshot: string;
  actorRoleSnapshot: "member" | "admin";
  verb: "approve" | "dismiss";
  reasonTag: DismissalReasonTag | null;
  authorSelfDismissal: boolean;
  findingKind: string | null;
  findingSeverity: string | null;
  findingConfidence: number | null;
  findingGeneratorModel: string | null;
  findingScorerModel: string | null;
  rationale: string;
  source: "github" | "dashboard";
  sourceCommentId: string | null;
  sourceUrl: string | null;
  sourceOrgId: number | null;
  sourceRepositoryId: number | null;
  sourceGithubInstallationId: number | null;
  sourceGithubRepoId: number | null;
  sourcePrNumber: number | null;
  sourceHeadSha: string | null;
  sourceWebhookDeliveryId: string | null;
  sourceGithubCommentId: number | null;
  sourceCommentKind: string | null;
  sourceBindingState: "exact" | "legacy";
  createdAt: Date;
  revokedAt: Date | null;
  revokedByUserId: number | null;
}

export interface ReviewForApproval {
  id: number;
  publicId: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  authorGithubId?: number | null;
  status: string;
  envelope: Envelope | null;
  engineGateFailing: boolean | null;
  gateFailing: boolean | null;
  gateCheckRunId: number | null;
  repoFullName: string;
  orgId: number;
  githubInstallationId: number;
  githubRepoId: number;
  installationAccountType: string;
}

export interface FindingApprovalState {
  finding: Finding;
  findingId: string;
  activeApproval: ApprovalRow | null;
  latestApproval: ApprovalRow | null;
  activeDismissal: ApprovalRow | null;
  latestDismissal: ApprovalRow | null;
  kindBlocking: boolean;
  severityBlocking: boolean;
  blocking: boolean;
  dismissible: boolean;
}

export interface ReviewApprovalState {
  review: ReviewForApproval;
  effectiveGate: EffectiveGateState;
  findingStates: FindingApprovalState[];
  dismissalFindingStates: FindingApprovalState[];
}

export interface ApprovalActor {
  userId: number;
  githubId: string;
  login: string;
  role: "member" | "admin";
}

export interface ApprovalInsert {
  reviewId: number;
  findingId: string;
  actor: ApprovalActor;
  rationale: string;
  verb?: "approve" | "dismiss";
  reasonTag?: DismissalReasonTag | null;
  authorSelfDismissal?: boolean;
  finding?: Finding;
  findingGeneratorModel?: string;
  findingScorerModel?: string | null;
  source: "github" | "dashboard";
  sourceCommentId?: string | null;
  sourceUrl?: string | null;
  binding: {
    orgId: number;
    repositoryId: number;
    githubInstallationId: number;
    githubRepoId: number;
    prNumber: number;
    headSha: string;
  };
  githubSource?: {
    webhookDeliveryId: string;
    githubCommentId: number;
    commentKind: "issue_comment" | "pull_request_review_comment";
  };
}

export interface ReviewGateStateSyncJobPayload extends Record<string, unknown> {
  reviewId: number;
  reviewPublicId: string;
  modeVersion?: number;
}

export interface OrganizationGateStateSyncJobPayload extends Record<
  string,
  unknown
> {
  orgId: number;
  modeVersion: number;
  cursor?: { queuedAt: string; reviewId: number };
}

export type GateStateSyncJobPayload =
  ReviewGateStateSyncJobPayload | OrganizationGateStateSyncJobPayload;

export function validateApprovalRationale(value: string): string {
  const rationale = value.trim();
  if (rationale.length === 0) throw new Error("approval rationale is required");
  return rationale;
}

export function parseEnvelopeForApprovals(value: unknown): Envelope | null {
  if (!value) return null;
  const parsed = envelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getActiveApprovalIds(
  db: Database,
  reviewId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ findingId: schema.findingApprovals.findingId })
    .from(schema.findingApprovals)
    .where(
      and(
        eq(schema.findingApprovals.reviewId, reviewId),
        eq(schema.findingApprovals.verb, "approve"),
        isNull(schema.findingApprovals.revokedAt),
      ),
    );
  return new Set(rows.map((row) => row.findingId));
}

export async function getActiveDismissalIds(db: Database, reviewId: number): Promise<Set<string>> {
  const rows = await db.select({ findingId: schema.findingApprovals.findingId })
    .from(schema.findingApprovals)
    .where(and(eq(schema.findingApprovals.reviewId, reviewId), eq(schema.findingApprovals.verb, "dismiss"), isNull(schema.findingApprovals.revokedAt)));
  return new Set(rows.map((row) => row.findingId));
}

export async function getReviewApprovalState(
  db: Database,
  review: ReviewForApproval,
): Promise<ReviewApprovalState> {
  const envelope = review.envelope;
  const approvals = await db
    .select()
    .from(schema.findingApprovals)
    .where(eq(schema.findingApprovals.reviewId, review.id))
    .orderBy(desc(schema.findingApprovals.createdAt), desc(schema.findingApprovals.id));
  const activeByFinding = new Map<string, Map<ApprovalRow["verb"], ApprovalRow>>();
  const latestByFinding = new Map<string, Map<ApprovalRow["verb"], ApprovalRow>>();
  for (const approval of approvals) {
    const latest = latestByFinding.get(approval.findingId) ?? new Map();
    if (!latest.has(approval.verb)) latest.set(approval.verb, approval);
    latestByFinding.set(approval.findingId, latest);
    if (!approval.revokedAt) {
      const active = activeByFinding.get(approval.findingId) ?? new Map();
      if (!active.has(approval.verb)) active.set(approval.verb, approval);
      activeByFinding.set(approval.findingId, active);
    }
  }
  const approvableIds = new Set(
    (envelope?.findings ?? []).flatMap((finding) => {
      const findingId = findingStableId(finding);
      return findingId && qualifiesHumanEscalation(finding) ? [findingId] : [];
    }),
  );
  const activeIds = new Set(
    Array.from(activeByFinding.entries()).flatMap(([findingId, rows]) =>
      rows.has("approve") && approvableIds.has(findingId) ? [findingId] : [],
    ),
  );
  const dismissedIds = new Set(
    Array.from(activeByFinding.entries()).flatMap(([findingId, rows]) =>
      rows.has("dismiss") ? [findingId] : [],
    ),
  );
  const effectiveGate = computeEffectiveGate(envelope, activeIds, dismissedIds);
  const undispositionedGate = computeEffectiveGate(envelope, new Set(), new Set());
  const blockById = new Map(
    [...undispositionedGate.blockers, ...undispositionedGate.kindBlockers]
      .filter((state) => state.findingId)
      .map((state) => [state.findingId!, state]),
  );
  const dismissalFindingStates = (envelope?.findings ?? [])
    .map((finding) => {
      const findingId = findingStableId(finding);
      if (!findingId) return null;
      const blockState = blockById.get(findingId);
      if (!blockState || (!blockState.kindBlocking && !blockState.severityBlocking)) return null;
      if (isOperationalFinding(finding)) return null;
      const active = activeByFinding.get(findingId);
      const latest = latestByFinding.get(findingId);
      const state: FindingApprovalState = {
        finding,
        findingId,
        activeApproval: active?.get("approve") ?? null,
        latestApproval: latest?.get("approve") ?? null,
        activeDismissal: active?.get("dismiss") ?? null,
        latestDismissal: latest?.get("dismiss") ?? null,
        kindBlocking: blockState.kindBlocking,
        severityBlocking: blockState.severityBlocking,
        blocking: effectiveGate.blockers.some((blocker) => blocker.findingId === findingId),
        dismissible: true,
      };
      return state;
    })
    .filter((state): state is FindingApprovalState => state !== null);
  const findingStates = dismissalFindingStates.filter((state) =>
    state.kindBlocking && qualifiesHumanEscalation(state.finding),
  );
  return { review, effectiveGate, findingStates, dismissalFindingStates };
}

export async function enqueueGateStateSync(
  db: Database,
  review: Pick<ReviewForApproval, "id" | "publicId">,
): Promise<void> {
  const payload: GateStateSyncJobPayload = {
    reviewId: review.id,
    reviewPublicId: review.publicId,
  };
  await db.insert(schema.jobs).values({
    kind: "gate-state-sync",
    payload,
    maxAttempts: 5,
  });
}

/** Reconcile the gate mode onto each pull request's latest terminal check. */
export async function enqueueLatestGateStateSyncsForOrganization(
  db: Database,
  orgId: number,
  modeVersion: number,
): Promise<void> {
  await db.insert(schema.jobs).values({
    kind: "gate-state-sync",
    payload: { orgId, modeVersion } satisfies OrganizationGateStateSyncJobPayload,
    maxAttempts: 5,
  });
}

export async function lockReviewApprovalState(
  db: Database,
  reviewId: number,
): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${reviewId})`);
}

/** Serialize a finding decision with review enqueue for the same pull request. */
export async function lockActiveReviewState(
  db: Database,
  review: Pick<ReviewForApproval, "githubRepoId" | "prNumber">,
): Promise<void> {
  const identity = [String(review.githubRepoId), String(review.prNumber)].join("\u001f");
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`postil:review-pr:${identity}`}, 0))`,
  );
}

export async function lockReviewDecisionScopeById(
  db: Database,
  reviewId: number,
): Promise<void> {
  const review = (await db.select({
    githubRepoId: schema.repositories.githubRepoId,
    prNumber: schema.reviews.prNumber,
  }).from(schema.reviews)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
    .where(eq(schema.reviews.id, reviewId)).limit(1))[0];
  if (!review?.githubRepoId) throw new Error("review decision scope is unavailable");
  await lockActiveReviewState(db, {
    githubRepoId: review.githubRepoId,
    prNumber: review.prNumber,
  });
  await lockReviewApprovalState(db, reviewId);
}

export async function updateStoredEffectiveGate(
  db: Database,
  reviewId: number,
  failing: boolean,
  gateEnabled = true,
): Promise<void> {
  await db
    .update(schema.reviews)
    .set({ gateFailing: gateEnabled && failing })
    .where(eq(schema.reviews.id, reviewId));
}

export async function insertFindingApproval(
  db: Database,
  input: ApprovalInsert,
): Promise<string> {
  const rationale = validateApprovalRationale(input.rationale);
  const verb = input.verb ?? "approve";
  if (
    verb === "dismiss" &&
    (!input.reasonTag || !input.finding || !input.findingGeneratorModel)
  ) {
    throw new Error("dismissal audit fields are required");
  }
  const rows = await db
    .insert(schema.findingApprovals)
    .values({
      reviewId: input.reviewId,
      findingId: input.findingId,
      actorUserId: input.actor.userId,
      actorGithubId: input.actor.githubId,
      actorLoginSnapshot: input.actor.login,
      actorRoleSnapshot: input.actor.role,
      verb,
      reasonTag: input.reasonTag ?? null,
      authorSelfDismissal: input.authorSelfDismissal ?? false,
      findingKind: input.finding?.kind ?? null,
      findingSeverity: input.finding?.severity ?? null,
      findingConfidence: input.finding?.confidence ?? null,
      findingGeneratorModel: input.findingGeneratorModel ?? null,
      findingScorerModel: input.findingScorerModel ?? null,
      rationale,
      source: input.source,
      sourceCommentId: input.sourceCommentId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceOrgId: input.binding.orgId,
      sourceRepositoryId: input.binding.repositoryId,
      sourceGithubInstallationId: input.binding.githubInstallationId,
      sourceGithubRepoId: input.binding.githubRepoId,
      sourcePrNumber: input.binding.prNumber,
      sourceHeadSha: input.binding.headSha,
      sourceWebhookDeliveryId: input.githubSource?.webhookDeliveryId ?? null,
      sourceGithubCommentId: input.githubSource?.githubCommentId ?? null,
      sourceCommentKind: input.githubSource?.commentKind ?? null,
      sourceBindingState: "exact",
    })
    .returning({ id: schema.findingApprovals.id });
  return rows[0]!.id;
}

export async function revokeFindingApproval(
  db: Database,
  reviewId: number,
  findingId: string,
  revokedByUserId: number,
  verb: "approve" | "dismiss" = "approve",
): Promise<string | null> {
  const rows = await db
    .update(schema.findingApprovals)
    .set({ revokedAt: new Date(), revokedByUserId })
    .where(
      and(
        eq(schema.findingApprovals.reviewId, reviewId),
        eq(schema.findingApprovals.findingId, findingId),
        eq(schema.findingApprovals.verb, verb),
        isNull(schema.findingApprovals.revokedAt),
      ),
    )
    .returning({ id: schema.findingApprovals.id });
  return rows[0]?.id ?? null;
}

export async function loadLatestCompletedReviewForPr(
  db: Database,
  githubInstallationId: number,
  githubRepoId: number,
  prNumber: number,
): Promise<ReviewForApproval | null> {
  const row = (
    await db
      .select({
        id: schema.reviews.id,
        publicId: schema.reviews.publicId,
        repositoryId: schema.reviews.repositoryId,
        prNumber: schema.reviews.prNumber,
        headSha: schema.reviews.headSha,
        authorGithubId: schema.reviews.authorGithubId,
        status: schema.reviews.status,
        envelope: schema.reviews.envelope,
        engineGateFailing: schema.reviews.engineGateFailing,
        gateFailing: schema.reviews.gateFailing,
        gateCheckRunId: schema.reviews.gateCheckRunId,
        repoFullName: schema.reviews.sourceRepoFullName,
        orgId: schema.reviews.sourceOrgId,
        githubInstallationId: schema.reviews.sourceGithubInstallationId,
        githubRepoId: schema.reviews.sourceGithubRepoId,
        installationAccountType: schema.installations.accountType,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(
        and(
          eq(schema.installations.githubInstallationId, githubInstallationId),
          eq(schema.repositories.githubRepoId, githubRepoId),
          eq(schema.reviews.sourceGithubInstallationId, githubInstallationId),
          eq(schema.reviews.sourceGithubRepoId, githubRepoId),
          eq(schema.reviews.prNumber, prNumber),
          eq(schema.reviews.status, "completed"),
          isNotNull(schema.reviews.envelope),
        ),
      )
      .orderBy(desc(schema.reviews.finishedAt), desc(schema.reviews.id))
      .limit(1)
  )[0];
  if (
    !row ||
    row.orgId == null ||
    row.githubInstallationId == null ||
    row.githubRepoId == null ||
    !row.repoFullName
  ) return null;
  return {
    ...row,
    repoFullName: row.repoFullName,
    orgId: row.orgId,
    githubInstallationId: row.githubInstallationId,
    githubRepoId: row.githubRepoId,
    envelope: parseEnvelopeForApprovals(row.envelope),
  };
}

export async function loadReviewForApprovalByPublicId(
  db: Database,
  orgId: number,
  publicId: string,
): Promise<ReviewForApproval | null> {
  const row = (
    await db
      .select({
        id: schema.reviews.id,
        publicId: schema.reviews.publicId,
        repositoryId: schema.reviews.repositoryId,
        prNumber: schema.reviews.prNumber,
        headSha: schema.reviews.headSha,
        authorGithubId: schema.reviews.authorGithubId,
        status: schema.reviews.status,
        envelope: schema.reviews.envelope,
        engineGateFailing: schema.reviews.engineGateFailing,
        gateFailing: schema.reviews.gateFailing,
        gateCheckRunId: schema.reviews.gateCheckRunId,
        repoFullName: schema.reviews.sourceRepoFullName,
        orgId: schema.reviews.sourceOrgId,
        githubInstallationId: schema.reviews.sourceGithubInstallationId,
        githubRepoId: schema.reviews.sourceGithubRepoId,
        installationAccountType: schema.installations.accountType,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(
        and(
          // Approval intentionally fails closed for reviews without the
          // immutable publication identity established by migration 0034.
          eq(schema.reviews.publicId, publicId),
          eq(schema.installations.orgId, orgId),
          eq(schema.reviews.sourceOrgId, orgId),
        ),
      )
      .limit(1)
  )[0];
  if (
    !row ||
    row.orgId == null ||
    row.githubInstallationId == null ||
    row.githubRepoId == null ||
    !row.repoFullName
  ) return null;
  return {
    ...row,
    repoFullName: row.repoFullName,
    orgId: row.orgId,
    githubInstallationId: row.githubInstallationId,
    githubRepoId: row.githubRepoId,
    envelope: parseEnvelopeForApprovals(row.envelope),
  };
}

export async function hasNewerCompletedReviewForHead(
  db: Database,
  review: ReviewForApproval,
): Promise<boolean> {
  const latestForHead = (
    await db
      .select({ id: schema.reviews.id })
      .from(schema.reviews)
      .where(
        and(
          eq(schema.reviews.repositoryId, review.repositoryId),
          eq(schema.reviews.prNumber, review.prNumber),
          eq(schema.reviews.headSha, review.headSha),
          eq(schema.reviews.status, "completed"),
          isNotNull(schema.reviews.envelope),
        ),
      )
      .orderBy(desc(schema.reviews.finishedAt), desc(schema.reviews.id))
      .limit(1)
  )[0];
  return Boolean(latestForHead && latestForHead.id !== review.id);
}

export async function hasNewerReviewForPr(
  db: Database,
  review: Pick<ReviewForApproval, "id" | "repositoryId" | "prNumber">,
): Promise<boolean> {
  const row = (await db.select({ id: schema.reviews.id }).from(schema.reviews).where(and(
    eq(schema.reviews.repositoryId, review.repositoryId),
    eq(schema.reviews.prNumber, review.prNumber),
    sql`${schema.reviews.id} > ${review.id}`,
    sql`${schema.reviews.status} <> 'stale'`,
  )).limit(1))[0];
  return Boolean(row);
}

export async function hasInFlightReviewForPr(
  db: Database,
  review: Pick<ReviewForApproval, "repositoryId" | "githubRepoId" | "prNumber">,
): Promise<boolean> {
  const reviewRow = (await db.select({ id: schema.reviews.id }).from(schema.reviews).where(and(
    eq(schema.reviews.repositoryId, review.repositoryId),
    eq(schema.reviews.prNumber, review.prNumber),
    sql`${schema.reviews.status} IN ('queued', 'running')`,
  )).limit(1))[0];
  if (reviewRow) return true;
  const jobRow = (await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(
    eq(schema.jobs.kind, "review"),
    sql`${schema.jobs.status} IN ('queued', 'running')`,
    sql`(
      ${schema.jobs.payload}->>'githubRepoId' = ${String(review.githubRepoId)}
      OR (
        NOT ${schema.jobs.payload} ? 'githubRepoId'
        AND ${schema.jobs.payload}->>'repoFullName' IN (
          SELECT ${schema.repositories.fullName}
          FROM ${schema.repositories}
          WHERE ${schema.repositories.id} = ${review.repositoryId}
        )
      )
    )`,
    sql`${schema.jobs.payload}->>'prNumber' = ${String(review.prNumber)}`,
  )).limit(1))[0];
  return Boolean(jobRow);
}

export function findKindBlockingState(
  state: ReviewApprovalState,
  findingId: string,
): FindingApprovalState | null {
  return state.findingStates.find((finding) => finding.findingId === findingId) ?? null;
}

export function findDismissibleFindingState(
  state: ReviewApprovalState,
  findingId: string,
): FindingApprovalState | null {
  return state.dismissalFindingStates.find((finding) => finding.findingId === findingId) ?? null;
}

/** Shortest finding-id prefix the approval command accepts. */
export const FINDING_ID_PREFIX_MIN_LENGTH = 8;

/** Length gate summaries truncate finding ids to; a valid approval prefix. */
export const FINDING_ID_DISPLAY_LENGTH = 12;

export type ApprovableFindingIdResolution =
  | { ok: true; findingId: string }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; matches: string[] };

/**
 * Resolve a finding id or id prefix against the review's approvable findings.
 * Gate summaries display truncated ids, so the approval command must accept
 * the truncated form. An exact id always wins; otherwise a prefix of at least
 * FINDING_ID_PREFIX_MIN_LENGTH characters resolves only when it names exactly
 * one approvable finding.
 */
export function resolveApprovableFindingId(
  state: ReviewApprovalState,
  input: string,
): ApprovableFindingIdResolution {
  return resolveFindingIdCandidates(
    state.findingStates.map((finding) => finding.findingId),
    input,
  );
}

export function resolveDismissibleFindingId(
  state: ReviewApprovalState,
  input: string,
): ApprovableFindingIdResolution {
  return resolveFindingIdCandidates(
    state.dismissalFindingStates
      .filter((finding) => finding.dismissible)
      .map((finding) => finding.findingId),
    input,
  );
}

function resolveFindingIdCandidates(
  candidates: readonly string[],
  input: string,
): ApprovableFindingIdResolution {
  if (candidates.includes(input)) return { ok: true, findingId: input };
  if (input.length < FINDING_ID_PREFIX_MIN_LENGTH) return { ok: false, reason: "unknown" };
  const matches = candidates.filter((findingId) => findingId.startsWith(input));
  if (matches.length === 1) return { ok: true, findingId: matches[0]! };
  return matches.length > 1 ? { ok: false, reason: "ambiguous", matches } : { ok: false, reason: "unknown" };
}

export function formatRemainingGateBlockers(
  state: EffectiveGateState,
  findingStates: FindingApprovalState[] = [],
): string {
  const dismissed = formatDismissedGateFindings(findingStates);
  if (!state.failing) {
    return ["No blocking findings remain.", dismissed || null]
      .filter(Boolean)
      .join("\n\n");
  }
  const truncatedCounts = new Map<string, number>();
  for (const blocker of state.blockers) {
    if (!blocker.findingId) continue;
    const prefix = blocker.findingId.slice(0, FINDING_ID_DISPLAY_LENGTH);
    truncatedCounts.set(prefix, (truncatedCounts.get(prefix) ?? 0) + 1);
  }
  const blockers = state.blockers
    .slice(0, 10)
    .map((blocker) => {
      // A truncated id must stay a usable `@postil approve` prefix, so ids
      // whose truncated forms collide are shown in full.
      const prefix = blocker.findingId?.slice(0, FINDING_ID_DISPLAY_LENGTH);
      const id = blocker.findingId && prefix
        ? ` ${(truncatedCounts.get(prefix) ?? 0) > 1 ? blocker.findingId : prefix}`
        : "";
      const reason = [
        blocker.severityBlocking ? `severity ${blocker.finding.severity}` : null,
        blocker.kindBlocking && !blocker.approved ? `kind ${blocker.finding.kind}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${blocker.finding.title}${id} (${reason})`;
    })
    .join("\n");
  return [blockers, dismissed || null]
    .filter(Boolean)
    .join("\n\n");
}

export function formatDismissedGateFindings(
  findingStates: FindingApprovalState[] = [],
): string {
  const dismissed = findingStates
    .filter((finding) => finding.activeDismissal)
    .map((finding) => {
      const dismissal = finding.activeDismissal!;
      return `- ${finding.finding.title} ${finding.findingId.slice(0, FINDING_ID_DISPLAY_LENGTH)} (Dismissed by @${dismissal.actorLoginSnapshot}: ${dismissal.reasonTag}${dismissal.authorSelfDismissal ? "; pull request author" : ""})`;
    });
  return dismissed.length > 0 ? `Dismissed findings:\n${dismissed.join("\n")}` : "";
}
