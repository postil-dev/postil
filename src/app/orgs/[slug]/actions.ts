"use server";

import { revalidatePath } from "next/cache";

import { and, eq, gt, sql } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
import { centsToMicros } from "@/lib/billing-credits";
import {
  BILLING_CONTACT_RESEND_COOLDOWN_MS,
  billingContactVerificationJobPayload,
  createBillingContactVerification,
  normalizeBillingContact,
} from "@/lib/billing-contact-verification";
import {
  parseApiFormat,
  validateAdditionalAuthHeader,
  validateAdditionalAuthValue,
} from "@/lib/byok-provider";
import { getSealingKey, seal, unseal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import { hostedInferenceEnabled } from "@/lib/env";
import { getOrgMembership } from "@/lib/org-access";
import { validateOrgConfigYaml } from "@/lib/org-review-config";
import { recordRepositoryEnablementEvent } from "@/lib/repository-enablement";
import { getSessionUser } from "@/lib/session";
import {
  enqueueGateStateSync,
  findKindBlockingState,
  getReviewApprovalState,
  hasNewerCompletedReviewForHead,
  insertFindingApproval,
  lockReviewApprovalState,
  loadReviewForApprovalByPublicId,
  revokeFindingApproval,
  updateStoredEffectiveGate,
  type ReviewForApproval,
} from "@/lib/finding-approvals";
import { getInstallationToken } from "@/lib/github/app-auth";
import { completeCheckRun, getPullRequestHeadSha } from "@/lib/github/checks";
import { getRepoConfigProbes } from "@/lib/github/config-probe";

export interface OrgSettingsActionState {
  status: "error" | "success";
  message: string;
}

export type ConfigProbeRefreshState =
  | { status: "idle" }
  | {
      status: "success" | "partial";
      checkedAt: string;
      repositoryCount: number;
      successfulCount: number;
      failedCount: number;
      configFileCount: number;
      message: string;
    }
  | {
      status: "cooldown";
      retryAfterSeconds: number;
      message: string;
    }
  | { status: "error"; message: string };

/**
 * Resolve org by slug and load the current user's membership row, returning
 * the org id and the user's role. Read access (dashboard viewing) only needs
 * membership; write actions additionally assert the admin role via
 * requireAdmin below.
 */
async function requireMembership(
  slug: string,
): Promise<{ orgId: number; role: string; userId: number }> {
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (access.reason === "verification_unavailable") {
      throw new Error("GitHub membership verification is temporarily unavailable");
    }
    if (access.reason === "unauthenticated") throw new Error("not signed in");
    throw new Error("organization not found");
  }
  return {
    orgId: access.org.id,
    role: access.membership.role,
    userId: access.user.id,
  };
}

/**
 * Resolve org by slug and assert the current user is an admin of it. Gates the
 * write actions (settings save, repository toggle): hosted review config, the
 * BYO LLM API key, and per-repo review coverage are org-wide controls, so a
 * plain member must not be able to overwrite or clear them. GitHub membership
 * verification supplies organization roles; personal accounts are always
 * admin.
 */
async function requireAdmin(slug: string): Promise<{ orgId: number; userId: number }> {
  const { orgId, role, userId } = await requireMembership(slug);
  if (role !== "admin") {
    throw new Error("this action requires an organization admin");
  }
  return { orgId, userId };
}

/** Owner-controlled hosted overage limit. BYOK spend remains provider-controlled. */
export async function updateHostedOverageCap(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId } = await requireAdmin(slug);
  const raw = String(formData.get("overageCapUsd") ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error("overage cap must be a nonnegative USD value with at most two decimals");
  }
  const [dollars, decimal = ""] = raw.split(".");
  const cents = Number(dollars) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("overage cap is too large");
  const updated = await getDb()
    .update(schema.organizationEntitlements)
    .set({
      overageHardCapMicros: centsToMicros(cents),
      overageHardCapCents: cents,
      updatedBy: `org-admin:${orgId}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.organizationEntitlements.orgId, orgId),
        eq(schema.organizationEntitlements.subscriptionMode, "hosted"),
      ),
    )
    .returning({ orgId: schema.organizationEntitlements.orgId });
  if (updated.length !== 1) throw new Error("an active hosted entitlement is required");
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/billing`);
}

export async function saveBillingContact(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId, userId } = await requireAdmin(slug);
  let requestedEmail: string | null;
  try {
    requestedEmail = normalizeBillingContact(String(formData.get("billingContact") ?? ""));
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Enter a valid billing email.",
    };
  }
  const db = getDb();
  const existing = (
    await db
      .select({
        activeEmail: schema.organizationEntitlements.billingContactEmail,
        pendingEmail: schema.organizationEntitlements.billingContactPending,
        verifiedAt: schema.organizationEntitlements.billingContactVerifiedAt,
      })
      .from(schema.organizationEntitlements)
      .where(eq(schema.organizationEntitlements.orgId, orgId))
      .limit(1)
  )[0];
  if (!existing) return { status: "error", message: "Activate billing before setting a contact." };

  const now = new Date();
  const clearPending = {
    billingContactPending: null,
    billingContactVerificationTokenDigest: null,
    billingContactVerificationTokenCiphertext: null,
    billingContactVerificationExpiresAt: null,
    billingContactVerificationRequestedAt: null,
    billingContactVerificationSentAt: null,
    billingContactVerificationMessageId: null,
  };
  let update: Record<string, unknown>;
  let verificationJob: { orgId: number; tokenDigest: string } | null = null;
  let message = "Billing contact saved.";
  if (!requestedEmail) {
    update = {
      billingContactEmail: null,
      billingContactVerifiedAt: null,
      ...clearPending,
    };
    message = "Billing contact removed.";
  } else if (requestedEmail === existing.activeEmail && existing.verifiedAt) {
    update = clearPending;
  } else if (requestedEmail === existing.pendingEmail) {
    update = {};
    message = "Check your email to verify the billing contact.";
  } else {
    const verification = createBillingContactVerification(orgId, requestedEmail, now);
    const pending = {
      billingContactPending: requestedEmail,
      billingContactVerificationTokenDigest: verification.tokenDigest,
      billingContactVerificationTokenCiphertext: verification.tokenCiphertext,
      billingContactVerificationExpiresAt: verification.expiresAt,
      billingContactVerificationRequestedAt: verification.requestedAt,
      billingContactVerificationSentAt: null,
      billingContactVerificationMessageId: null,
    };
    update = existing.verifiedAt
      ? pending
      : { billingContactEmail: null, billingContactVerifiedAt: null, ...pending };
    verificationJob = billingContactVerificationJobPayload(orgId, verification.tokenDigest);
    message = existing.verifiedAt
      ? "Check your email to verify the replacement. The verified contact remains active."
      : "Check your email to verify the billing contact.";
  }
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(schema.organizationEntitlements)
      .set({ ...update, updatedBy: `billing-admin:${userId}`, updatedAt: now })
      .where(eq(schema.organizationEntitlements.orgId, orgId))
      .returning({ orgId: schema.organizationEntitlements.orgId });
    if (changed.length !== 1) throw new Error("billing entitlement changed; retry");
    if (verificationJob) {
      await tx.insert(schema.jobs).values({
        kind: "billing-contact-verification",
        payload: verificationJob,
        maxAttempts: 5,
      });
    }
  });
  revalidatePath(`/orgs/${slug}/billing`);
  return { status: "success", message };
}

export async function resendBillingContactVerification(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId, userId } = await requireAdmin(slug);
  const db = getDb();
  const now = new Date();
  const row = (
    await db
      .select({
        pendingEmail: schema.organizationEntitlements.billingContactPending,
        requestedAt: schema.organizationEntitlements.billingContactVerificationRequestedAt,
      })
      .from(schema.organizationEntitlements)
      .where(eq(schema.organizationEntitlements.orgId, orgId))
      .limit(1)
  )[0];
  if (!row?.pendingEmail) {
    return { status: "error", message: "No billing contact is waiting for verification." };
  }
  if (
    row.requestedAt &&
    now.getTime() - row.requestedAt.getTime() < BILLING_CONTACT_RESEND_COOLDOWN_MS
  ) {
    return { status: "error", message: "Wait a minute before sending another email." };
  }
  const pendingEmail = row.pendingEmail;
  const verification = createBillingContactVerification(orgId, pendingEmail, now);
  const payload = billingContactVerificationJobPayload(orgId, verification.tokenDigest);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.organizationEntitlements)
      .set({
        billingContactVerificationTokenDigest: verification.tokenDigest,
        billingContactVerificationTokenCiphertext: verification.tokenCiphertext,
        billingContactVerificationExpiresAt: verification.expiresAt,
        billingContactVerificationRequestedAt: verification.requestedAt,
        billingContactVerificationSentAt: null,
        billingContactVerificationMessageId: null,
        updatedBy: `billing-admin:${userId}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.organizationEntitlements.orgId, orgId),
          eq(schema.organizationEntitlements.billingContactPending, pendingEmail),
        ),
      )
      .returning({ orgId: schema.organizationEntitlements.orgId });
    if (updated.length !== 1) throw new Error("billing contact changed; retry");
    await tx.insert(schema.jobs).values({
      kind: "billing-contact-verification",
      payload,
      maxAttempts: 5,
    });
  });
  revalidatePath(`/orgs/${slug}/billing`);
  return { status: "success", message: "Verification email queued." };
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

export async function refreshOrgConfigProbes(
  _previousState: ConfigProbeRefreshState,
  formData: FormData,
): Promise<ConfigProbeRefreshState> {
  const slug = String(formData.get("slug") ?? "");
  try {
    const { orgId } = await requireAdmin(slug);
    const db = getDb();
    const refreshedAt = new Date();

    // The atomic conflict predicate makes this limit durable across all web
    // processes. A separate org-scoped row is necessary because failed probes
    // deliberately preserve each repository's last successful probedAt value.
    const acquired = await db.execute(sql`
      INSERT INTO "org_config_probe_refreshes" ("org_id", "refreshed_at")
      VALUES (${orgId}, ${refreshedAt})
      ON CONFLICT ("org_id") DO UPDATE
        SET "refreshed_at" = EXCLUDED."refreshed_at"
        WHERE "org_config_probe_refreshes"."refreshed_at"
          <= EXCLUDED."refreshed_at" - interval '30 seconds'
      RETURNING "org_id"
    `);
    if (acquired.rows.length === 0) {
      return {
        status: "cooldown",
        retryAfterSeconds: 30,
        message: "Checked recently. Try again in 30 seconds.",
      };
    }

    const repos = await db
      .select({
        repositoryId: schema.repositories.id,
        githubInstallationId: schema.installations.githubInstallationId,
        fullName: schema.repositories.fullName,
      })
      .from(schema.repositories)
      .innerJoin(
        schema.installations,
        eq(schema.installations.id, schema.repositories.installationId),
      )
      .where(
        and(eq(schema.installations.orgId, orgId), eq(schema.repositories.enabled, true)),
      );
    const probes = await getRepoConfigProbes(db, repos, { force: true, now: refreshedAt });
    const successfulCount = probes.filter((probe) => probe.ok).length;
    const failedCount = repos.length - successfulCount;
    const configFileCount = probes.reduce(
      (count, probe) => count + (probe.ok ? probe.files.length : 0),
      0,
    );
    revalidatePath(`/orgs/${slug}/settings`);
    return {
      status: failedCount > 0 ? "partial" : "success",
      checkedAt: refreshedAt.toISOString(),
      repositoryCount: repos.length,
      successfulCount,
      failedCount,
      configFileCount,
      message:
        failedCount > 0
          ? `Checked ${repos.length} repositories; ${failedCount} could not be reached.`
          : `Checked ${repos.length} repositories and found ${configFileCount} config files.`,
    };
  } catch (error) {
    console.error("organization config re-check failed", error);
    return {
      status: "error",
      message: "Could not re-check config files. Try again.",
    };
  }
}

export async function saveOrgSettings(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId } = await requireAdmin(slug);

  const providerMode = String(formData.get("providerMode") ?? "hosted").trim();
  if (providerMode !== "hosted" && providerMode !== "byok") {
    return { status: "error", message: "Choose hosted inference or bring your own key." };
  }
  const apiBase = String(formData.get("apiBase") ?? "").trim() || null;
  const apiFormatInput = String(formData.get("apiFormat") ?? "openai-compatible").trim();
  const apiFormat = parseApiFormat(apiFormatInput);
  const model = String(formData.get("model") ?? "").trim() || null;
  const modelCascade = String(formData.get("modelCascade") ?? "").trim() || null;
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const apiKeyAction = String(formData.get("apiKeyAction") ?? "keep").trim();
  const apiAuthHeader = String(formData.get("apiAuthHeader") ?? "").trim();
  const apiAuthValue = String(formData.get("apiAuthValue") ?? "").trim();
  const apiAuthAction = String(formData.get("apiAuthAction") ?? "keep").trim();
  const configYamlBody = String(formData.get("configYaml") ?? "");
  const configYaml = configYamlBody.trim().length > 0 ? configYamlBody : null;
  const guardrailsBody = String(formData.get("guardrailsMd") ?? "");
  const guardrailsMd = guardrailsBody.trim().length > 0 ? guardrailsBody : null;
  const contentPolicyBody = String(formData.get("contentPolicyMd") ?? "");
  const contentPolicyMd =
    contentPolicyBody.trim().length > 0 ? contentPolicyBody : null;
  const sharedConfigValues = formData.getAll("sharedConfigEnabled").map(String);
  const sharedConfigEnabled =
    sharedConfigValues.length === 0 || sharedConfigValues.includes("on");
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
  const removingByok = providerMode === "hosted" || apiKeyAction === "remove";
  const requestedMode = removingByok ? "hosted" : "byok";
  const now = new Date();
  if (!removingByok) {
    if (!apiFormat) {
      return { status: "error", message: "Choose a supported API interface." };
    }
    if (!apiBase) {
      return { status: "error", message: "Enter the provider API URL." };
    }
    // Guard against internal-network targets: the worker hands this URL to the
    // CLI as POSTIL_API_BASE and fetches it with the worker's network identity.
    await validateApiBase(apiBase);
    if (!model) {
      return { status: "error", message: "Enter the primary model." };
    }
  }

  const base = {
    apiBase: removingByok ? null : apiBase,
    apiFormat: removingByok ? "openai-compatible" : apiFormat!,
    model: removingByok ? null : model,
    modelCascade: removingByok ? null : modelCascade,
    configYaml,
    guardrailsMd,
    contentPolicyMd,
    sharedConfigEnabled,
    updatedAt: now,
  };

  // The key is write-only: set when provided, cleared when requested,
  // otherwise left untouched. It is never read back to the form.
  let keyUpdate: { apiKeyCiphertext: Buffer | null } | Record<string, never> = {};
  if (removingByok) {
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

  let authUpdate:
    | { apiAuthHeaderCiphertext: Buffer | null; apiAuthValueCiphertext: Buffer | null }
    | Record<string, never> = {};
  if (removingByok || apiAuthAction === "remove") {
    authUpdate = { apiAuthHeaderCiphertext: null, apiAuthValueCiphertext: null };
  } else if (apiAuthAction === "replace") {
    if (!apiAuthHeader || !apiAuthValue) {
      return {
        status: "error",
        message: "Enter both the additional authentication header and value.",
      };
    }
    validateAdditionalAuthHeader(apiAuthHeader, apiFormat!);
    validateAdditionalAuthValue(apiAuthValue);
    const sealingKey = getSealingKey();
    authUpdate = {
      apiAuthHeaderCiphertext: seal(apiAuthHeader, sealingKey),
      apiAuthValueCiphertext: seal(apiAuthValue, sealingKey),
    };
  } else if (apiAuthAction !== "keep") {
    return { status: "error", message: "Choose how to update additional authentication." };
  }

  const modeError = await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT "org_id"
      FROM "organization_entitlements"
      WHERE "org_id" = ${orgId}
      FOR UPDATE
    `);
    await tx.execute(sql`
      SELECT "org_id"
      FROM "org_settings"
      WHERE "org_id" = ${orgId}
      FOR UPDATE
    `);
    const entitlement = (
      await tx
        .select({
          subscriptionMode: schema.organizationEntitlements.subscriptionMode,
          status: schema.organizationEntitlements.status,
          trialEndsAt: schema.organizationEntitlements.trialEndsAt,
        })
        .from(schema.organizationEntitlements)
        .where(eq(schema.organizationEntitlements.orgId, orgId))
        .limit(1)
    )[0];
    const currentSettings = (
      await tx
        .select({
          apiKeyCiphertext: schema.orgSettings.apiKeyCiphertext,
          apiAuthHeaderCiphertext: schema.orgSettings.apiAuthHeaderCiphertext,
        })
        .from(schema.orgSettings)
        .where(eq(schema.orgSettings.orgId, orgId))
        .limit(1)
    )[0];
    const activeTrial = Boolean(
      entitlement?.status === "trialing" &&
        entitlement.trialEndsAt &&
        entitlement.trialEndsAt > now,
    );
    if (
      requestedMode === "hosted" &&
      !hostedInferenceEnabled() &&
      entitlement?.subscriptionMode !== "hosted"
    ) {
      return {
        status: "error" as const,
        message: "Hosted inference is paused. Use your provider.",
      };
    }
    if (
      (entitlement?.subscriptionMode === "hosted" ||
        entitlement?.subscriptionMode === "byok") &&
      entitlement.subscriptionMode !== requestedMode &&
      !activeTrial
    ) {
      return {
        status: "error" as const,
        message: `Your plan uses ${entitlement.subscriptionMode === "byok" ? "BYOK" : "hosted inference"}. Change the plan before switching inference mode.`,
      };
    }
    if (!removingByok && apiKeyAction === "keep" && !currentSettings?.apiKeyCiphertext) {
      return { status: "error" as const, message: "Enter a provider key to enable BYOK." };
    }
    if (
      !removingByok &&
      apiAuthAction === "keep" &&
      currentSettings?.apiAuthHeaderCiphertext
    ) {
      const storedHeader = unseal(
        Buffer.from(currentSettings.apiAuthHeaderCiphertext),
        getSealingKey(),
      );
      validateAdditionalAuthHeader(storedHeader, apiFormat!);
    }

    await tx
      .insert(schema.orgSettings)
      .values({
        orgId,
        ...base,
        apiKeyCiphertext: "apiKeyCiphertext" in keyUpdate ? keyUpdate.apiKeyCiphertext : null,
        apiAuthHeaderCiphertext:
          "apiAuthHeaderCiphertext" in authUpdate ? authUpdate.apiAuthHeaderCiphertext : null,
        apiAuthValueCiphertext:
          "apiAuthValueCiphertext" in authUpdate ? authUpdate.apiAuthValueCiphertext : null,
      })
      .onConflictDoUpdate({
        target: schema.orgSettings.orgId,
        set: { ...base, ...keyUpdate, ...authUpdate },
      });
    if (activeTrial) {
      const switched = await tx
        .update(schema.organizationEntitlements)
        .set({
          subscriptionMode: requestedMode,
          updatedBy: "trial-provider-mode",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.organizationEntitlements.orgId, orgId),
            eq(schema.organizationEntitlements.status, "trialing"),
            gt(schema.organizationEntitlements.trialEndsAt, now),
          ),
        )
        .returning({ orgId: schema.organizationEntitlements.orgId });
      if (switched.length !== 1) {
        throw new Error("The free trial ended before the provider change was saved.");
      }
    }
    return null;
  });
  if (modeError) return modeError;
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/settings`);
  return { status: "success", message: "Organization settings saved." };
}

async function assertDashboardReviewApprovable(review: ReviewForApproval): Promise<void> {
  if (review.status !== "completed") throw new Error("review must be completed");
  if (!review.envelope) throw new Error("review must have an envelope");
  if (!review.gateCheckRunId) throw new Error("review has no gate check-run");
}

async function requireCurrentReviewHead(review: ReviewForApproval): Promise<string> {
  const signal = AbortSignal.timeout(10_000);
  const token = await getInstallationToken(review.githubInstallationId, signal);
  const currentHeadSha = await getPullRequestHeadSha(
    token,
    review.repoFullName,
    review.prNumber,
    signal,
  );
  if (currentHeadSha !== review.headSha) {
    throw new Error("the pull request changed after this review; use the latest review");
  }
  if (await hasNewerCompletedReviewForHead(getDb(), review)) {
    throw new Error("a newer completed review exists for this commit");
  }
  return token;
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
  await requireCurrentReviewHead(review);
  const user = await getSessionUser();
  if (!user?.githubId) throw new Error("user has no github id");
  await db.transaction(async (tx) => {
    await lockReviewApprovalState(tx, review.id);
    const state = await getReviewApprovalState(tx, review);
    const finding = findKindBlockingState(state, findingId);
    if (!finding || !finding.blocking || finding.activeApproval || finding.latestApproval?.revokedAt) {
      throw new Error("that finding is absent, already approved, revoked, or no longer kind-blocking");
    }
    if (finding.severityBlocking) {
      throw new Error("this finding is also severity-blocking, and approvals only clear kind-based blocks");
    }
    await insertFindingApproval(tx, {
      reviewId: review.id,
      findingId,
      actor: {
        userId,
        githubId: String(user.githubId),
        login: user.login,
        role: "admin",
      },
      rationale,
      source: "dashboard",
    });
    const nextState = await getReviewApprovalState(tx, review);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing);
    await enqueueGateStateSync(tx, review);
  });
  void import("@/worker/runner").then(({ triggerQueueDrain }) =>
    triggerQueueDrain("gate-state-sync"),
  );
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
  await assertDashboardReviewApprovable(review);
  const token = await requireCurrentReviewHead(review);
  await db.transaction(async (tx) => {
    await lockReviewApprovalState(tx, review.id);
    const state = await getReviewApprovalState(tx, review);
    const finding = findKindBlockingState(state, findingId);
    if (!finding?.activeApproval) throw new Error("that finding has no active approval");
    if (!review.gateCheckRunId) throw new Error("review has no gate check-run");
    await completeCheckRun(
      token,
      review.repoFullName,
      review.gateCheckRunId,
      "failure",
      "Postil gate approval revoked",
      "An organization admin revoked a human judgment approval. The pull request is blocked until a new review resolves the finding or an eligible approval is recorded.",
      AbortSignal.timeout(10_000),
    );
    const revokedApprovalId = await revokeFindingApproval(tx, review.id, findingId, userId);
    if (!revokedApprovalId) throw new Error("that finding has no active approval");
    const nextState = await getReviewApprovalState(tx, review);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing);
    await enqueueGateStateSync(tx, review);
  });
  void import("@/worker/runner").then(({ triggerQueueDrain }) =>
    triggerQueueDrain("gate-state-sync"),
  );
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
}
