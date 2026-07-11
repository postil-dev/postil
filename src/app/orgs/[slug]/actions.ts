"use server";

import { revalidatePath } from "next/cache";

import { and, eq } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { getSealingKey, seal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import { validateOrgConfigYaml } from "@/lib/org-review-config";
import { recordRepositoryEnablementEvent } from "@/lib/repository-enablement";
import { getSessionUser } from "@/lib/session";
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
  type ReviewForApproval,
} from "@/lib/finding-approvals";
import { getInstallationToken } from "@/lib/github/app-auth";
import { completeCheckRun, getPullRequestHeadSha } from "@/lib/github/checks";

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
): Promise<{ orgId: number; role: string; userId: number }> {
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
  return { orgId: org.id, role: member.role, userId: user.id };
}

/**
 * Resolve org by slug and assert the current user is an admin of it. Gates the
 * write actions (settings save, repository toggle): hosted review config, the
 * BYO LLM API key, and per-repo review coverage are org-wide controls, so a
 * plain member must not be able to overwrite or clear them. Roles are sourced
 * from GitHub org membership at login (admin/member); personal accounts are
 * always admin.
 */
async function requireAdmin(slug: string): Promise<{ orgId: number; userId: number }> {
  const { orgId, role, userId } = await requireMembership(slug);
  if (role !== "admin") {
    throw new Error("this action requires an organization admin");
  }
  return { orgId, userId };
}

export async function toggleRepository(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const repositoryId = Number(formData.get("repositoryId"));
  const enable = formData.get("enable") === "true";
  const { orgId, userId } = await requireAdmin(slug);

  const db = getDb();
  // Constrain the update to repositories that actually belong to this org.
  const repo = (
    await db
      .select({
        id: schema.repositories.id,
        installationId: schema.repositories.installationId,
        githubRepoId: schema.repositories.githubRepoId,
        fullName: schema.repositories.fullName,
        private: schema.repositories.private,
        enabled: schema.repositories.enabled,
      })
      .from(schema.repositories)
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(and(eq(schema.repositories.id, repositoryId), eq(schema.installations.orgId, orgId)))
      .limit(1)
  )[0];
  if (!repo) throw new Error("repository not found in this organization");

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.repositories)
      .set({ enabled: enable })
      .where(
        and(
          eq(schema.repositories.id, repo.id),
          eq(schema.repositories.installationId, repo.installationId),
        ),
      )
      .returning({ id: schema.repositories.id });
    if (!updated[0]) throw new Error("repository changed organizations; retry the toggle");
    if (repo.enabled !== enable) {
      await recordRepositoryEnablementEvent(tx, {
        orgId,
        repositoryId: repo.id,
        githubRepoId: repo.githubRepoId,
        repositoryFullName: repo.fullName,
        repositoryPrivate: repo.private,
        action: enable ? "enable" : "disable",
        actorUserId: userId,
        source: "dashboard",
      });
    }
  });
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/billing`);
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


async function assertDashboardReviewApprovable(review: ReviewForApproval): Promise<void> {
  if (review.status !== "completed") throw new Error("review must be completed");
  if (!review.envelope) throw new Error("review must have an envelope");
}

export async function approveFinding(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const publicId = String(formData.get("publicId") ?? "");
  const findingId = String(formData.get("findingId") ?? "").trim();
  const rationale = String(formData.get("rationale") ?? "");
  const { orgId, userId } = await requireAdmin(slug);
  const db = getDb();
  const review = await loadReviewForApprovalByPublicId(db, orgId, publicId);
  if (!review) throw new Error("review not found in this organization");
  await assertDashboardReviewApprovable(review);
  const state = await getReviewApprovalState(db, review);
  const finding = findKindBlockingState(state, findingId);
  if (!finding || !finding.blocking || finding.activeApproval || finding.latestApproval?.revokedAt) {
    throw new Error("that finding is absent, already approved, revoked, or no longer kind-blocking");
  }
  if (finding.severityBlocking) {
    throw new Error("this finding is also severity-blocking, and approvals only clear kind-based blocks");
  }
  const user = await getSessionUser();
  if (!user?.githubId) throw new Error("user has no github id");
  await db.transaction(async (tx) => {
    await insertFindingApproval(tx, {
      reviewId: review.id,
      findingId,
      actor: {
        userId,
        githubId: user.githubId!,
        login: user.login,
        role: "admin",
      },
      rationale,
      source: "dashboard",
    });
    const nextState = await getReviewApprovalState(tx, review);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing);
  });
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
}

export async function revokeFinding(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const publicId = String(formData.get("publicId") ?? "");
  const findingId = String(formData.get("findingId") ?? "").trim();
  const { orgId, userId } = await requireAdmin(slug);
  const db = getDb();
  const review = await loadReviewForApprovalByPublicId(db, orgId, publicId);
  if (!review) throw new Error("review not found in this organization");
  await db.transaction(async (tx) => {
    await revokeFindingApproval(tx, review.id, findingId, userId);
    const nextState = await getReviewApprovalState(tx, review);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing);
  });
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
}
