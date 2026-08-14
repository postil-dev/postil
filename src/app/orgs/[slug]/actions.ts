"use server";

import { revalidatePath } from "next/cache";

import { and, eq, gt, sql } from "drizzle-orm";

import { validateApiBase } from "@/lib/api-base";
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
import { getDb, getPool, schema } from "@/lib/db";
import { hostedInferenceAvailable } from "@/lib/env";
import { lockOrganizationGateMode } from "@/lib/gate-mode";
import { DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES } from "@/lib/organization-notification-preferences";
import { getOrgMembership } from "@/lib/org-access";
import { MembershipVerificationUnavailableError } from "@/lib/auth-navigation";
import { validateOrgConfigYaml } from "@/lib/org-review-config";
import { recordRepositoryEnablementEvent } from "@/lib/repository-enablement";
import { getSessionUser } from "@/lib/session";
import {
  enqueueGateStateSync,
  enqueueLatestGateStateSyncsForOrganization,
  findDismissibleFindingState,
  findKindBlockingState,
  getReviewApprovalState,
  hasInFlightReviewForPr,
  hasNewerCompletedReviewForHead,
  hasNewerReviewForPr,
  insertFindingApproval,
  lockActiveReviewState,
  lockReviewApprovalState,
  loadReviewForApprovalByPublicId,
  revokeFindingApproval,
  updateStoredEffectiveGate,
  type ReviewForApproval,
} from "@/lib/finding-approvals";
import { getInstallationToken } from "@/lib/github/app-auth";
import { loadLiveApprovalActor } from "@/lib/github/approval-actor";
import { getPullRequestHeadSha, getPullRequestReviewContext } from "@/lib/github/checks";
import { getRepoConfigProbes } from "@/lib/github/config-probe";
import { githubInstallationSettingsUrl } from "@/lib/github-app";
import { checkGithubAppRepositoryAccess } from "@/lib/github/installation-sync";
import {
  enqueueGateEnforcementSweepOnce,
  findActiveGateEnforcementSweep,
  getGateEnforcementSweepStatus,
} from "@/lib/queue";

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

export type RepositoryAccessCheckState =
  | { status: "idle" }
  | {
      status: "selected" | "not_installed" | "not_selected" | "unknown";
      message: string;
      settingsUrl?: string;
    };

export type GateEnforcementRefreshState =
  | { status: "idle"; pollGeneration: number }
  | { status: "queued" | "active"; message: string; jobId: number; pollGeneration: number }
  | { status: "error"; message: string; pollGeneration: number };

export type GateEnforcementRefreshProgress =
  | { status: "pending" }
  | { status: "completed" }
  | { status: "failed" }
  | { status: "missing" };

/**
 * Resolve org by slug and load the current user's membership row, returning
 * the org id and the user's role. Read access (dashboard viewing) only needs
 * membership; write actions additionally assert the admin role via
 * requireAdmin below.
 */
async function requireMembership(slug: string): Promise<{
  orgId: number;
  role: string;
  userId: number;
  org: { name: string; githubOrgId: number | null };
}> {
  const access = await getOrgMembership(slug);
  if (!access.ok) {
    if (access.reason === "verification_unavailable") {
      throw new MembershipVerificationUnavailableError(access.retryAvailableAt);
    }
    if (access.reason === "unauthenticated") throw new Error("not signed in");
    throw new Error("organization not found");
  }
  return {
    orgId: access.org.id,
    role: access.membership.role,
    userId: access.user.id,
    org: { name: access.org.name, githubOrgId: access.org.githubOrgId },
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
async function requireAdmin(
  slug: string,
): Promise<{
  orgId: number;
  userId: number;
  org: { name: string; githubOrgId: number | null };
}> {
  const { orgId, role, userId, org } = await requireMembership(slug);
  if (role !== "admin") {
    throw new Error("this action requires an organization admin");
  }
  return { orgId, userId, org };
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

export async function saveNotificationPreferences(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId, userId } = await requireAdmin(slug);
  const next = {
    billingSummaryEmail: formData.getAll("billingSummaryEmail").includes("on"),
    serviceSummaryEmail: formData.getAll("serviceSummaryEmail").includes("on"),
  };
  const db = getDb();
  const now = new Date();

  await db.transaction(async (tx) => {
    const existing = (
      await tx
        .select({
          billingSummaryEmail:
            schema.organizationNotificationPreferences.billingSummaryEmail,
          serviceSummaryEmail:
            schema.organizationNotificationPreferences.serviceSummaryEmail,
        })
        .from(schema.organizationNotificationPreferences)
        .where(eq(schema.organizationNotificationPreferences.orgId, orgId))
        .limit(1)
    )[0] ?? DEFAULT_ORGANIZATION_NOTIFICATION_PREFERENCES;

    await tx
      .insert(schema.organizationNotificationPreferences)
      .values({ orgId, ...next, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.organizationNotificationPreferences.orgId,
        set: { ...next, updatedAt: now },
      });

    const events = [
      existing.billingSummaryEmail === next.billingSummaryEmail
        ? null
        : {
            orgId,
            setting: "billing_summary_email",
            value: next.billingSummaryEmail ? "enabled" : "disabled",
            actorUserId: userId,
            source: "dashboard",
          },
      existing.serviceSummaryEmail === next.serviceSummaryEmail
        ? null
        : {
            orgId,
            setting: "service_summary_email",
            value: next.serviceSummaryEmail ? "enabled" : "disabled",
            actorUserId: userId,
            source: "dashboard",
          },
    ].filter((event): event is NonNullable<typeof event> => event !== null);
    if (events.length > 0) {
      await tx.insert(schema.organizationSettingEvents).values(events);
    }
  });

  revalidatePath(`/orgs/${slug}/billing`);
  revalidatePath(`/orgs/${slug}/settings/audit`);
  return { status: "success", message: "Notification preferences saved." };
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

export async function checkRepositoryAccess(
  _previousState: RepositoryAccessCheckState,
  formData: FormData,
): Promise<RepositoryAccessCheckState> {
  const slug = String(formData.get("slug") ?? "");
  const owner = String(formData.get("owner") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const { org } = await requireAdmin(slug);

  if (!isGithubRepositorySegment(owner) || !isGithubRepositorySegment(name)) {
    return {
      status: "unknown",
      message: "Enter a valid repository owner and name.",
    };
  }

  if (org.githubOrgId === null) {
    return {
      status: "unknown",
      message: "Enter the GitHub owner linked to this organization.",
    };
  }

  const result = await checkGithubAppRepositoryAccess(
    owner,
    name,
    org.githubOrgId,
  );
  if (result.status === "not_installed") {
    return {
      status: "not_installed",
      message: `${owner}/${name} cannot receive Postil reviews or checks because the GitHub App is not installed for ${owner}. Postil cannot inspect configuration in this repository.`,
    };
  }
  const settingsUrl = result.installation
    ? githubInstallationSettingsUrl(result.installation)
    : undefined;
  if (result.status === "selected") {
    return {
      status: "selected",
      message: `${owner}/${name} is selected for this GitHub App installation.`,
      settingsUrl,
    };
  }
  if (result.status === "not_selected") {
    return {
      status: "not_selected",
      message: `${owner}/${name} cannot receive Postil reviews or checks because it is not selected for this GitHub App installation. Postil cannot inspect configuration in this repository.`,
      settingsUrl,
    };
  }
  return {
    status: "unknown",
    message: "Repository access could not be confirmed. Try again.",
    settingsUrl,
  };
}

function isGithubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value);
}

export async function refreshGateEnforcement(
  previousState: GateEnforcementRefreshState,
  formData: FormData,
): Promise<GateEnforcementRefreshState> {
  const slug = String(formData.get("slug") ?? "");
  const pollGeneration = previousState.pollGeneration + 1;
  try {
    const { orgId } = await requireAdmin(slug);
    const pool = getPool();
    const queuedJobId = await enqueueGateEnforcementSweepOnce(pool, { orgId });
    if (queuedJobId !== null) {
      return {
        status: "queued",
        message: "Repository rules are being checked.",
        jobId: queuedJobId,
        pollGeneration,
      };
    }
    const activeJobId = await findActiveGateEnforcementSweep(pool, orgId);
    if (activeJobId === null) {
      return {
        status: "error",
        message: "Could not locate the active check. Try again.",
        pollGeneration,
      };
    }
    return {
      status: "active",
      message: "Repository rules are being checked.",
      jobId: activeJobId,
      pollGeneration,
    };
  } catch (error) {
    console.error("gate enforcement re-check failed", error);
    return {
      status: "error",
      message: "Could not queue the checks. Try again.",
      pollGeneration,
    };
  }
}

export async function getGateEnforcementRefreshProgress(
  slug: string,
  jobId: number,
): Promise<GateEnforcementRefreshProgress> {
  const { orgId } = await requireAdmin(slug);
  const status = await getGateEnforcementSweepStatus(getPool(), { jobId, orgId });
  if (status === "queued" || status === "running") return { status: "pending" };
  if (status === "done") {
    revalidatePath(`/orgs/${slug}/settings`);
    return { status: "completed" };
  }
  return { status: status === "failed" ? "failed" : "missing" };
}

/**
 * Turn the merge gate on or off for the organization. A dedicated action so the
 * dashboard toggle saves on change; the gate-mode advisory lock, audit event,
 * and organization-wide gate-state reconciliation match the previous combined
 * settings save.
 */
export async function setOrgGateEnabled(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId, userId } = await requireAdmin(slug);
  const gateEnabled = String(formData.get("gateEnabled") ?? "") === "on";
  const db = getDb();
  const now = new Date();
  let gateModeChanged = false;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`postil:gate-mode:${orgId}`}, 0))`,
    );
    await tx.execute(sql`
      SELECT "org_id"
      FROM "org_settings"
      WHERE "org_id" = ${orgId}
      FOR UPDATE
    `);
    const current = (
      await tx
        .select({ gateEnabled: schema.orgSettings.gateEnabled })
        .from(schema.orgSettings)
        .where(eq(schema.orgSettings.orgId, orgId))
        .limit(1)
    )[0];
    gateModeChanged = (current?.gateEnabled ?? false) !== gateEnabled;
    await tx
      .insert(schema.orgSettings)
      .values({ orgId, gateEnabled, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.orgSettings.orgId,
        set: { gateEnabled, updatedAt: now },
      });
    if (gateModeChanged) {
      const event = (
        await tx
          .insert(schema.organizationSettingEvents)
          .values({
            orgId,
            setting: "gate_enabled",
            value: gateEnabled ? "enabled" : "advisory",
            actorUserId: userId,
            source: "dashboard",
          })
          .returning({ id: schema.organizationSettingEvents.id })
      )[0];
      if (!event) throw new Error("gate setting audit event was not recorded");
      await enqueueLatestGateStateSyncsForOrganization(tx, orgId, event.id);
    }
  });
  if (gateModeChanged) {
    void import("@/worker/runner").then(({ triggerQueueDrain }) =>
      triggerQueueDrain("gate-state-sync"),
    );
  }
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/settings`);
  return {
    status: "success",
    message: gateEnabled
      ? "Merge gate on. Blocking findings fail postil/gate."
      : "Merge gate off. Reviews are advisory.",
  };
}

/** Turn shared owner configuration on or off, saving on change. */
export async function setOrgSharedConfigEnabled(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId, userId } = await requireAdmin(slug);
  const sharedConfigEnabled = String(formData.get("sharedConfigEnabled") ?? "") === "on";
  const db = getDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT "org_id"
      FROM "org_settings"
      WHERE "org_id" = ${orgId}
      FOR UPDATE
    `);
    const current = (
      await tx
        .select({ sharedConfigEnabled: schema.orgSettings.sharedConfigEnabled })
        .from(schema.orgSettings)
        .where(eq(schema.orgSettings.orgId, orgId))
        .limit(1)
    )[0];
    const changed = (current?.sharedConfigEnabled ?? true) !== sharedConfigEnabled;
    await tx
      .insert(schema.orgSettings)
      .values({ orgId, sharedConfigEnabled, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.orgSettings.orgId,
        set: { sharedConfigEnabled, updatedAt: now },
      });
    if (changed) {
      await tx.insert(schema.organizationSettingEvents).values({
        orgId,
        setting: "shared_config_enabled",
        value: sharedConfigEnabled ? "enabled" : "disabled",
        actorUserId: userId,
        source: "dashboard",
      });
    }
  });
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/settings`);
  return {
    status: "success",
    message: sharedConfigEnabled
      ? "Shared owner configuration on."
      : "Shared owner configuration off.",
  };
}

/**
 * Save the organization fallback config texts. Split from the inference save so
 * the dashboard can save them on change without touching provider settings.
 */
export async function saveOrgConfigFallbacks(
  _previousState: OrgSettingsActionState | null,
  formData: FormData,
): Promise<OrgSettingsActionState> {
  const slug = String(formData.get("slug") ?? "");
  const { orgId } = await requireAdmin(slug);
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
  const now = new Date();
  const values = { configYaml, guardrailsMd, contentPolicyMd, updatedAt: now };
  await db
    .insert(schema.orgSettings)
    .values({ orgId, ...values })
    .onConflictDoUpdate({ target: schema.orgSettings.orgId, set: values });
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/settings`);
  return { status: "success", message: "Config fallbacks saved." };
}

export async function saveOrgInferenceSettings(
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

  const managedHostedInferenceAvailable = await hostedInferenceAvailable(getPool());
  const modeError = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`postil:gate-mode:${orgId}`}, 0))`,
    );
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
      !managedHostedInferenceAvailable &&
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
  return { status: "success", message: "Inference settings saved." };
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
    await lockActiveReviewState(tx, review);
    await lockReviewApprovalState(tx, review.id);
    if (await hasInFlightReviewForPr(tx, review)) {
      throw new Error("a review is in progress; re-issue after it completes");
    }
    if (await hasNewerReviewForPr(tx, review)) {
      throw new Error("a newer review exists for this pull request");
    }
    const state = await getReviewApprovalState(tx, review);
    const finding = findKindBlockingState(state, findingId);
    if (!finding || !finding.blocking || finding.activeApproval || finding.activeDismissal || finding.latestApproval?.revokedAt) {
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
      binding: {
        orgId: review.orgId,
        repositoryId: review.repositoryId,
        githubInstallationId: review.githubInstallationId,
        githubRepoId: review.githubRepoId,
        prNumber: review.prNumber,
        headSha: review.headSha,
      },
    });
    const nextState = await getReviewApprovalState(tx, review);
    const gateEnabled = await lockOrganizationGateMode(tx, orgId);
    await updateStoredEffectiveGate(
      tx,
      review.id,
      nextState.effectiveGate.failing,
      gateEnabled,
    );
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
  await requireCurrentReviewHead(review);
  await db.transaction(async (tx) => {
    await lockActiveReviewState(tx, review);
    await lockReviewApprovalState(tx, review.id);
    if (await hasInFlightReviewForPr(tx, review)) {
      throw new Error("a review is in progress; re-issue after it completes");
    }
    if (await hasNewerReviewForPr(tx, review)) {
      throw new Error("a newer review exists for this pull request");
    }
    const state = await getReviewApprovalState(tx, review);
    const finding = findKindBlockingState(state, findingId);
    if (!finding?.activeApproval) throw new Error("that finding has no active approval");
    const revokedApprovalId = await revokeFindingApproval(tx, review.id, findingId, userId);
    if (!revokedApprovalId) throw new Error("that finding has no active approval");
    const nextState = await getReviewApprovalState(tx, review);
    const gateEnabled = await lockOrganizationGateMode(tx, orgId);
    await updateStoredEffectiveGate(
      tx,
      review.id,
      nextState.effectiveGate.failing,
      gateEnabled,
    );
    await enqueueGateStateSync(tx, review);
  });
  void import("@/worker/runner").then(({ triggerQueueDrain }) =>
    triggerQueueDrain("gate-state-sync"),
  );
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
}

export async function dismissFinding(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const publicId = String(formData.get("publicId") ?? "");
  const findingId = String(formData.get("findingId") ?? "").trim();
  const reasonTag = String(formData.get("reasonTag") ?? "");
  const rationale = String(formData.get("rationale") ?? "");
  if (!(["false-positive", "accepted-risk", "out-of-scope"] as const).includes(reasonTag as never)) {
    throw new Error("dismissal requires a valid reason tag");
  }
  const { orgId } = await requireAdmin(slug);
  const db = getDb();
  const review = await loadReviewForApprovalByPublicId(db, orgId, publicId);
  if (!review) throw new Error("review not found in this organization");
  await assertDashboardReviewApprovable(review);
  const token = await requireCurrentReviewHead(review);
  if (await hasInFlightReviewForPr(db, review)) {
    throw new Error("a review is in progress; re-issue after it completes");
  }
  const user = await getSessionUser();
  if (!user?.githubId) throw new Error("user has no github id");
  const actor = await loadLiveApprovalActor(
    review,
    { id: Number(user.githubId), login: user.login },
    review.repoFullName,
    token,
  );
  if (!actor || actor.role !== "admin") {
    throw new Error("GitHub could not verify this account as an active organization admin");
  }
  const authorGithubId = review.authorGithubId ?? (
    await getPullRequestReviewContext(token, review.repoFullName, review.prNumber)
  ).authorGithubId ?? null;
  await db.transaction(async (tx) => {
    await lockActiveReviewState(tx, review);
    await lockReviewApprovalState(tx, review.id);
    if (await hasNewerReviewForPr(tx, review)) {
      throw new Error("a newer review exists for this pull request");
    }
    if (await hasInFlightReviewForPr(tx, review)) {
      throw new Error("a review is in progress; re-issue after it completes");
    }
    const state = await getReviewApprovalState(tx, review);
    const finding = findDismissibleFindingState(state, findingId);
    if (!finding || finding.activeDismissal || finding.activeApproval) {
      throw new Error("that finding is absent, operational, already dismissed, or has an active approval");
    }
    await insertFindingApproval(tx, {
      reviewId: review.id,
      findingId,
      actor,
      rationale,
      verb: "dismiss",
      reasonTag: reasonTag as "false-positive" | "accepted-risk" | "out-of-scope",
      authorSelfDismissal: authorGithubId === Number(actor.githubId),
      finding: finding.finding,
      findingModel: review.envelope!.modelUsed,
      source: "dashboard",
      binding: {
        orgId: review.orgId,
        repositoryId: review.repositoryId,
        githubInstallationId: review.githubInstallationId,
        githubRepoId: review.githubRepoId,
        prNumber: review.prNumber,
        headSha: review.headSha,
      },
    });
    const nextState = await getReviewApprovalState(tx, review);
    const gateEnabled = await lockOrganizationGateMode(tx, orgId);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing, gateEnabled);
    await enqueueGateStateSync(tx, review);
  });
  void import("@/worker/runner").then(({ triggerQueueDrain }) => triggerQueueDrain("gate-state-sync"));
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
}

export interface DismissFindingActionState {
  status: "idle" | "error" | "success";
  message: string;
}

const DISMISSAL_ACTION_ERRORS = new Set([
  "dismissal requires a valid reason tag",
  "review not found in this organization",
  "review must be completed",
  "review must have an envelope",
  "review has no gate check-run",
  "the pull request changed after this review; use the latest review",
  "a newer completed review exists for this commit",
  "a newer review exists for this pull request",
  "a review is in progress; re-issue after it completes",
  "approval rationale is required",
  "user has no github id",
  "GitHub could not verify this account as an active organization admin",
  "that finding is absent, operational, already dismissed, or has an active approval",
]);

export async function dismissFindingWithState(
  _previousState: DismissFindingActionState,
  formData: FormData,
): Promise<DismissFindingActionState> {
  try {
    await dismissFinding(formData);
    return { status: "success", message: "Dismissal recorded. The gate update is queued." };
  } catch (error) {
    const message = error instanceof Error && DISMISSAL_ACTION_ERRORS.has(error.message)
      ? error.message
      : "Dismissal could not be recorded. Refresh the run and try again.";
    return { status: "error", message };
  }
}

export async function revokeFindingDismissal(formData: FormData): Promise<void> {
  const slug = String(formData.get("slug") ?? "");
  const publicId = String(formData.get("publicId") ?? "");
  const findingId = String(formData.get("findingId") ?? "").trim();
  const { orgId } = await requireAdmin(slug);
  const db = getDb();
  const review = await loadReviewForApprovalByPublicId(db, orgId, publicId);
  if (!review) throw new Error("review not found in this organization");
  await assertDashboardReviewApprovable(review);
  const token = await requireCurrentReviewHead(review);
  const user = await getSessionUser();
  if (!user?.githubId) throw new Error("user has no github id");
  const actor = await loadLiveApprovalActor(
    review,
    { id: Number(user.githubId), login: user.login },
    review.repoFullName,
    token,
  );
  if (!actor || actor.role !== "admin") {
    throw new Error("GitHub could not verify this account as an active organization admin");
  }
  await db.transaction(async (tx) => {
    await lockActiveReviewState(tx, review);
    await lockReviewApprovalState(tx, review.id);
    if (await hasInFlightReviewForPr(tx, review)) {
      throw new Error("a review is in progress; re-issue after it completes");
    }
    if (await hasNewerReviewForPr(tx, review)) {
      throw new Error("a newer review exists for this pull request");
    }
    const state = await getReviewApprovalState(tx, review);
    if (!findDismissibleFindingState(state, findingId)?.activeDismissal) {
      throw new Error("that finding has no active dismissal");
    }
    if (!await revokeFindingApproval(tx, review.id, findingId, actor.userId, "dismiss")) {
      throw new Error("that finding has no active dismissal");
    }
    const nextState = await getReviewApprovalState(tx, review);
    const gateEnabled = await lockOrganizationGateMode(tx, orgId);
    await updateStoredEffectiveGate(tx, review.id, nextState.effectiveGate.failing, gateEnabled);
    await enqueueGateStateSync(tx, review);
  });
  void import("@/worker/runner").then(({ triggerQueueDrain }) => triggerQueueDrain("gate-state-sync"));
  revalidatePath(`/orgs/${slug}`);
  revalidatePath(`/orgs/${slug}/runs/${publicId}`);
}

export async function revokeFindingDismissalWithState(
  _previousState: DismissFindingActionState,
  formData: FormData,
): Promise<DismissFindingActionState> {
  try {
    await revokeFindingDismissal(formData);
    return { status: "success", message: "Dismissal revoked. The gate update is queued." };
  } catch (error) {
    const known = new Set([
      "review not found in this organization",
      "user has no github id",
      "GitHub could not verify this account as an active organization admin",
      "a newer review exists for this pull request",
      "a review is in progress; re-issue after it completes",
      "the pull request changed after this review; use the latest review",
      "a newer completed review exists for this commit",
      "review must be completed",
      "review must have an envelope",
      "review has no gate check-run",
      "that finding has no active dismissal",
    ]);
    const message = error instanceof Error && known.has(error.message)
      ? error.message
      : "Dismissal could not be revoked. Refresh the run and try again.";
    return { status: "error", message };
  }
}
