"use server";

import { revalidatePath } from "next/cache";

import { and, eq } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { getSealingKey, seal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import {
  deleteApprovalById,
  findKindBlockingState,
  formatRemainingGateBlockers,
  getReviewApprovalState,
  hasNewerCompletedReviewForHead,
  insertFindingApproval,
  loadReviewForApprovalByPublicId,
  restoreRevokedApprovalById,
  revokeFindingApproval,
  updateStoredEffectiveGate,
} from "@/lib/finding-approvals";
import { getInstallationToken } from "@/lib/github/app-auth";
import { completeCheckRun, getPullRequestHeadSha } from "@/lib/github/checks";
import { validateOrgConfigYaml } from "@/lib/org-review-config";
import { getSessionUser, type SessionUser } from "@/lib/session";

export interface OrgSettingsActionState {
  status: "error" | "success";
  message: string;
}

/**
 * Resolve org by slug and load the current user's membership row, returning
 * the org id and the user's role. Read access (dashboard viewing) only needs
 * membership; write actions additionally assert the admin role via
 * requireAdmin below.
 */
async function requireMembership(
  slug: string,
): Promise<{ orgId: number; role: string; user: SessionUser }> {
  const user = await getSessionUser();
  if (!user) throw new Error("not signed in");
  const db = getDb();
  const org = (
    await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug))
      .limit(1)
  )[0];
  if (!org) throw new Error("organization not found");
  const member = (
    await db
      .select({ role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, org.id), eq(schema.orgMembers.userId, user.id)))
      .limit(1)
  )[0];
  if (!member) throw new Error("not a member of this organization");
  return { orgId: org.id, role: member.role, user };
}

/**
 * Resolve org by slug and assert the current user is an admin of it. Gates the
 * write actions (settings save, repository toggle): hosted review config, the
 * BYO LLM API key, and per-repo review coverage are org-wide controls, so a
 * plain member must not be able to overwrite or clear them. Roles are sourced
 * from GitHub org membership at login (admin/member); personal accounts are
 * always admin.
 */
async function requireAdmin(slug: string): Promise<{ orgId: number; user: SessionUser; role: "admin" }> {
  const { orgId, role, user } = await requireMembership(slug);
  if (role !== "admin") {
    throw new Error("this action requires an organization admin");
  }
  return { orgId, user, role: "admin" };
}

export async function toggleRepository(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const repositoryId = Number(formData.get("repositoryId"));
  const enable = formData.get("enable") === "true";
  const { orgId } = await requireAdmin(slug);

  const db = getDb();
  // Constrain the update to repositories that actually belong to this org.
  const repo = (
    await db
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(and(eq(schema.repositories.id, repositoryId), eq(schema.installations.orgId, orgId)))
      .limit(1)
  )[0];
  if (!repo) throw new Error("repository not found in this organization");

  await db
    .update(schema.repositories)
    .set({ enabled: enable })
    .where(eq(schema.repositories.id, repo.id));
  revalidatePath(`/orgs/${slug}`);
}

export async function saveOrgSettings(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId } = await requireAdmin(slug);

  const apiBase = String(formData.get("apiBase") ?? "").trim() || null;
  // Guard against internal-network targets: the worker hands this URL to the
  // CLI as POSTIL_API_BASE and fetches it with the worker's network identity.
  if (apiBase) await validateApiBase(apiBase);
  const model = String(formData.get("model") ?? "").trim() || null;
  const modelCascade = String(formData.get("modelCascade") ?? "").trim() || null;
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const apiKeyAction = String(formData.get("apiKeyAction") ?? "keep").trim();
  const configYamlBody = String(formData.get("configYaml") ?? "");
  const configYaml = configYamlBody.trim().length > 0 ? configYamlBody : null;
  const guardrailsBody = String(formData.get("guardrailsMd") ?? "");
  const guardrailsMd = guardrailsBody.trim().length > 0 ? guardrailsBody : null;
  const contentPolicyBody = String(formData.get("contentPolicyMd") ?? "");
  const contentPolicyMd =
    contentPolicyBody.trim().length > 0 ? contentPolicyBody : null;

  if (configYaml) {
    try {
      validateOrgConfigYaml(configYaml);
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Config YAML is invalid.",
      };
    }
  }

  const db = getDb();
  const base = {
    apiBase,
    model,
    modelCascade,
    configYaml,
    guardrailsMd,
    contentPolicyMd,
    updatedAt: new Date(),
  };

  // The key is write-only: set when provided, cleared when requested,
  // otherwise left untouched. It is never read back to the form.
  let keyUpdate: { apiKeyCiphertext: Buffer | null } | Record<string, never> = {};
  if (apiKeyAction === "remove") {
    keyUpdate = { apiKeyCiphertext: null };
  } else if (apiKeyAction === "replace") {
    if (apiKey.length === 0) {
      return {
        status: "error",
        message: "Enter a new API key before replacing the stored key.",
      };
    }
    keyUpdate = { apiKeyCiphertext: seal(apiKey, getSealingKey()) };
  } else if (apiKeyAction !== "keep") {
    return {
      status: "error",
      message: "Choose whether to update, remove, or keep the API key.",
    };
  }

  await db
    .insert(schema.orgSettings)
    .values({
      orgId,
      ...base,
      apiKeyCiphertext: "apiKeyCiphertext" in keyUpdate ? keyUpdate.apiKeyCiphertext : null,
    })
    .onConflictDoUpdate({
      target: schema.orgSettings.orgId,
      set: { ...base, ...keyUpdate },
    });
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/settings`);
  return { status: "success", message: "Organization settings saved." };
}

export async function approveFinding(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const publicId = String(formData.get("publicId") ?? "");
  const findingId = String(formData.get("findingId") ?? "").trim();
  const rationale = String(formData.get("rationale") ?? "");
  const { orgId, user, role } = await requireAdmin(slug);
  const db = getDb();
  const review = await loadReviewForApprovalByPublicId(db, orgId, publicId);
  if (!review) throw new Error("review not found in this organization");
  await assertDashboardReviewApprovable(review);
  const state = await getReviewApprovalState(db, review);
  const finding = findKindBlockingState(state, findingId);
  if (!finding || !finding.blocking || finding.activeApproval || finding.latestApproval?.revokedAt) {
    throw new Error("finding is absent, already approved, revoked, or no longer kind-blocking");
  }
  if (finding.severityBlocking) {
    throw new Error("approvals only clear kind-based blocks");
  }

  const actor = {
    userId: user.id,
    githubId: String(user.githubId),
    login: user.login,
    role,
  };
  let approvalId: string | null = null;
  let nextState: Awaited<ReturnType<typeof getReviewApprovalState>> | null = null;
  await db.transaction(async (tx) => {
    approvalId = await insertFindingApproval(tx, {
      reviewId: review.id,
      findingId,
      actor,
      rationale,
      source: "dashboard",
    });
    nextState = await getReviewApprovalState(tx, review);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing);
  });
  try {
    await patchDashboardGateCheck(review, nextState!.effectiveGate);
  } catch (err) {
    if (approvalId) {
      await deleteApprovalById(db, approvalId);
      const reverted = await getReviewApprovalState(db, review);
      await updateStoredEffectiveGate(db, review.id, reverted.effectiveGate.failing);
    }
    throw new Error(
      `approval was not applied because the gate check-run could not be patched: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
  revalidatePath(`/orgs/${slug}`);
}

export async function revokeFinding(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const publicId = String(formData.get("publicId") ?? "");
  const findingId = String(formData.get("findingId") ?? "").trim();
  const { orgId, user } = await requireAdmin(slug);
  const db = getDb();
  const review = await loadReviewForApprovalByPublicId(db, orgId, publicId);
  if (!review) throw new Error("review not found in this organization");
  await assertDashboardReviewApprovable(review);
  let approvalId: string | null = null;
  let nextState: Awaited<ReturnType<typeof getReviewApprovalState>> | null = null;
  await db.transaction(async (tx) => {
    approvalId = await revokeFindingApproval(tx, review.id, findingId, user.id);
    if (!approvalId) throw new Error("approval is already revoked or superseded");
    nextState = await getReviewApprovalState(tx, review);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing);
  });
  try {
    await patchDashboardGateCheck(review, nextState!.effectiveGate);
  } catch (err) {
    if (approvalId) {
      await restoreRevokedApprovalById(db, approvalId);
      const reverted = await getReviewApprovalState(db, review);
      await updateStoredEffectiveGate(db, review.id, reverted.effectiveGate.failing);
    }
    throw new Error(
      `approval was not revoked because the gate check-run could not be patched: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
  revalidatePath(`/orgs/${slug}`);
}

async function assertDashboardReviewApprovable(
  review: NonNullable<Awaited<ReturnType<typeof loadReviewForApprovalByPublicId>>>,
): Promise<void> {
  if (review.status !== "completed" || !review.envelope) {
    throw new Error("approvals require a completed review with a stored envelope");
  }
  const token = await getInstallationToken(review.githubInstallationId);
  const currentHeadSha = await getPullRequestHeadSha(token, review.repoFullName, review.prNumber);
  if (currentHeadSha !== review.headSha) {
    throw new Error("approval rejected because the pull request head no longer matches this review");
  }
  if (await hasNewerCompletedReviewForHead(getDb(), review)) {
    throw new Error("approval rejected because a newer completed review exists for this commit");
  }
}

async function patchDashboardGateCheck(
  review: NonNullable<Awaited<ReturnType<typeof loadReviewForApprovalByPublicId>>>,
  gate: Awaited<ReturnType<typeof getReviewApprovalState>>["effectiveGate"],
): Promise<void> {
  if (!review.gateCheckRunId) throw new Error("review has no gate check-run id");
  const token = await getInstallationToken(review.githubInstallationId);
  await completeCheckRun(
    token,
    review.repoFullName,
    review.gateCheckRunId,
    gate.failing ? "failure" : "success",
    gate.failing ? "Postil gate still failing" : "Postil gate approved",
    gate.failing
      ? `One or more blocking findings remain after approval changes.\n\n${formatRemainingGateBlockers(gate)}`
      : "All kind-based blocking findings for this reviewed commit have active admin approvals.",
  );
}
