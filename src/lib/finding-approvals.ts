import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  computeEffectiveGate,
  envelopeSchema,
  findingStableId,
  qualifiesHumanEscalation,
  type EffectiveGateState,
  type Envelope,
  type Finding,
} from "@/lib/envelope";

export interface ApprovalRow {
  id: string;
  reviewId: number;
  findingId: string;
  actorUserId: number;
  actorGithubId: string;
  actorLoginSnapshot: string;
  actorRoleSnapshot: "member" | "admin";
  rationale: string;
  source: "github" | "dashboard";
  sourceCommentId: string | null;
  sourceUrl: string | null;
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
  status: string;
  envelope: Envelope | null;
  engineGateFailing: boolean | null;
  gateFailing: boolean | null;
  gateCheckRunId: number | null;
  repoFullName: string;
  orgId: number | null;
  githubInstallationId: number;
}

export interface FindingApprovalState {
  finding: Finding;
  findingId: string;
  activeApproval: ApprovalRow | null;
  latestApproval: ApprovalRow | null;
  kindBlocking: boolean;
  severityBlocking: boolean;
  blocking: boolean;
}

export interface ReviewApprovalState {
  review: ReviewForApproval;
  effectiveGate: EffectiveGateState;
  findingStates: FindingApprovalState[];
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
  source: "github" | "dashboard";
  sourceCommentId?: string | null;
  sourceUrl?: string | null;
}

export interface GateStateSyncJobPayload extends Record<string, unknown> {
  reviewId: number;
  reviewPublicId: string;
}

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
        isNull(schema.findingApprovals.revokedAt),
      ),
    );
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
  const activeByFinding = new Map<string, ApprovalRow>();
  const latestByFinding = new Map<string, ApprovalRow>();
  for (const approval of approvals) {
    if (!latestByFinding.has(approval.findingId)) latestByFinding.set(approval.findingId, approval);
    if (!approval.revokedAt) activeByFinding.set(approval.findingId, approval);
  }
  const approvableIds = new Set(
    (envelope?.findings ?? []).flatMap((finding) => {
      const findingId = findingStableId(finding);
      return findingId && qualifiesHumanEscalation(finding) ? [findingId] : [];
    }),
  );
  const activeIds = new Set(
    Array.from(activeByFinding.keys()).filter((findingId) => approvableIds.has(findingId)),
  );
  const effectiveGate = computeEffectiveGate(envelope, activeIds, review.engineGateFailing ?? false);
  const blockById = new Map(
    effectiveGate.kindBlockers
      .filter((state) => state.findingId)
      .map((state) => [state.findingId!, state]),
  );
  const findingStates = (envelope?.findings ?? [])
    .map((finding) => {
      const findingId = findingStableId(finding);
      if (!findingId) return null;
      if (!qualifiesHumanEscalation(finding)) return null;
      const blockState = blockById.get(findingId);
      if (!blockState?.kindBlocking) return null;
      const state: FindingApprovalState = {
        finding,
        findingId,
        activeApproval: activeByFinding.get(findingId) ?? null,
        latestApproval: latestByFinding.get(findingId) ?? null,
        kindBlocking: blockState.kindBlocking,
        severityBlocking: blockState.severityBlocking,
        blocking: blockState.blocking,
      };
      return state;
    })
    .filter((state): state is FindingApprovalState => state !== null);
  return { review, effectiveGate, findingStates };
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

export async function lockReviewApprovalState(
  db: Database,
  reviewId: number,
): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${reviewId})`);
}

export async function updateStoredEffectiveGate(
  db: Database,
  reviewId: number,
  failing: boolean,
): Promise<void> {
  await db.update(schema.reviews).set({ gateFailing: failing }).where(eq(schema.reviews.id, reviewId));
}

export async function insertFindingApproval(
  db: Database,
  input: ApprovalInsert,
): Promise<string> {
  const rationale = validateApprovalRationale(input.rationale);
  const rows = await db
    .insert(schema.findingApprovals)
    .values({
      reviewId: input.reviewId,
      findingId: input.findingId,
      actorUserId: input.actor.userId,
      actorGithubId: input.actor.githubId,
      actorLoginSnapshot: input.actor.login,
      actorRoleSnapshot: input.actor.role,
      rationale,
      source: input.source,
      sourceCommentId: input.sourceCommentId ?? null,
      sourceUrl: input.sourceUrl ?? null,
    })
    .returning({ id: schema.findingApprovals.id });
  return rows[0]!.id;
}

export async function revokeFindingApproval(
  db: Database,
  reviewId: number,
  findingId: string,
  revokedByUserId: number,
): Promise<string | null> {
  const rows = await db
    .update(schema.findingApprovals)
    .set({ revokedAt: new Date(), revokedByUserId })
    .where(
      and(
        eq(schema.findingApprovals.reviewId, reviewId),
        eq(schema.findingApprovals.findingId, findingId),
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
        status: schema.reviews.status,
        envelope: schema.reviews.envelope,
        engineGateFailing: schema.reviews.engineGateFailing,
        gateFailing: schema.reviews.gateFailing,
        gateCheckRunId: schema.reviews.gateCheckRunId,
        repoFullName: schema.repositories.fullName,
        orgId: schema.installations.orgId,
        githubInstallationId: schema.installations.githubInstallationId,
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
          eq(schema.reviews.prNumber, prNumber),
          eq(schema.reviews.status, "completed"),
          isNotNull(schema.reviews.envelope),
        ),
      )
      .orderBy(desc(schema.reviews.finishedAt), desc(schema.reviews.id))
      .limit(1)
  )[0];
  if (!row) return null;
  return { ...row, envelope: parseEnvelopeForApprovals(row.envelope) };
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
        status: schema.reviews.status,
        envelope: schema.reviews.envelope,
        engineGateFailing: schema.reviews.engineGateFailing,
        gateFailing: schema.reviews.gateFailing,
        gateCheckRunId: schema.reviews.gateCheckRunId,
        repoFullName: schema.repositories.fullName,
        orgId: schema.installations.orgId,
        githubInstallationId: schema.installations.githubInstallationId,
      })
      .from(schema.reviews)
      .innerJoin(schema.repositories, eq(schema.repositories.id, schema.reviews.repositoryId))
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(and(eq(schema.reviews.publicId, publicId), eq(schema.installations.orgId, orgId)))
      .limit(1)
  )[0];
  if (!row) return null;
  return { ...row, envelope: parseEnvelopeForApprovals(row.envelope) };
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

export function findKindBlockingState(
  state: ReviewApprovalState,
  findingId: string,
): FindingApprovalState | null {
  return state.findingStates.find((finding) => finding.findingId === findingId) ?? null;
}

export function formatRemainingGateBlockers(state: EffectiveGateState): string {
  if (!state.failing) return "No blocking findings remain.";
  return state.blockers
    .slice(0, 10)
    .map((blocker) => {
      const id = blocker.findingId ? ` ${blocker.findingId.slice(0, 12)}` : "";
      const reason = [
        blocker.severityBlocking ? `severity ${blocker.finding.severity}` : null,
        blocker.kindBlocking && !blocker.approved ? `kind ${blocker.finding.kind}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${blocker.finding.title}${id} (${reason})`;
    })
    .join("\n");
}
