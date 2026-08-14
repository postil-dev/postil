import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { seal, unseal } from "@/lib/crypto/seal";

let sessionUser: { id: number; githubId?: string; login?: string } | null = { id: 10 };
let orgRows: Array<{ id: number }> = [{ id: 20 }];
let memberRows: Array<{ role: string }> = [{ role: "admin" }];
let insertedValues: Record<string, unknown> | null = null;
let conflictSet: Record<string, unknown> | null = null;
let insertCount = 0;
let settingsRows: Array<Record<string, unknown>> = [];
let billingRows: Array<Record<string, unknown>> = [];
let notificationPreferenceRows: Array<Record<string, unknown>> = [];
let queuedJobs: Array<Record<string, unknown>> = [];
let updatedValues: Record<string, unknown> | null = null;
let updateResultRows: Array<Record<string, unknown>> = [];
let approvalInserted = false;
let gateSyncJobs = 0;
let organizationGateSyncJobs = 0;
let settingEvents: Array<Record<string, unknown>> = [];
let storedGateStates: boolean[] = [];
let checkConclusions: string[] = [];
let checkError: Error | null = null;
let liveApprovalActor: { userId: number; githubId: string; login: string; role: "admin" } | null = null;
let dismissalActive = false;
let authorDismissalAwaitingAcknowledgement = false;
let inFlightReview = false;

const approvalReview = {
  id: 7,
  publicId: "11111111-1111-4111-8111-111111111111",
  repositoryId: 2,
  prNumber: 9,
  headSha: "a".repeat(40),
  status: "completed",
  envelope: { version: 1 },
  engineGateFailing: true,
  gateFailing: true,
  gateCheckRunId: 99,
  repoFullName: "acme/repo",
  orgId: 20,
  githubInstallationId: 42,
};

const schema = {
  organizations: { id: "organizations.id", slug: "organizations.slug" },
  orgMembers: {
    orgId: "org_members.org_id",
    userId: "org_members.user_id",
    role: "org_members.role",
  },
  orgSettings: {
    orgId: "org_settings.org_id",
    gateEnabled: "org_settings.gate_enabled",
    apiKeyCiphertext: "org_settings.api_key_ciphertext",
    apiAuthHeaderCiphertext: "org_settings.api_auth_header_ciphertext",
    updatedAt: "org_settings.updated_at",
  },
  organizationEntitlements: {
    orgId: "organization_entitlements.org_id",
    subscriptionMode: "organization_entitlements.subscription_mode",
    status: "organization_entitlements.status",
    trialEndsAt: "organization_entitlements.trial_ends_at",
    billingContactEmail: "organization_entitlements.billing_contact_email",
    billingContactPending: "organization_entitlements.billing_contact_pending",
    billingContactVerifiedAt: "organization_entitlements.billing_contact_verified_at",
    billingContactVerificationTokenDigest:
      "organization_entitlements.billing_contact_verification_token_digest",
    billingContactVerificationTokenCiphertext:
      "organization_entitlements.billing_contact_verification_token_ciphertext",
    billingContactVerificationExpiresAt:
      "organization_entitlements.billing_contact_verification_expires_at",
    billingContactVerificationRequestedAt:
      "organization_entitlements.billing_contact_verification_requested_at",
    billingContactVerificationSentAt:
      "organization_entitlements.billing_contact_verification_sent_at",
    billingContactVerificationMessageId:
      "organization_entitlements.billing_contact_verification_message_id",
  },
  organizationNotificationPreferences: {
    orgId: "organization_notification_preferences.org_id",
    billingSummaryEmail:
      "organization_notification_preferences.billing_summary_email",
    serviceSummaryEmail:
      "organization_notification_preferences.service_summary_email",
  },
  jobs: { kind: "jobs.kind" },
  organizationSettingEvents: {
    id: "organization_setting_events.id",
  },
};

mock.module("next/cache", () => ({
  revalidatePath: () => undefined,
}));

mock.module("@/lib/session", () => ({
  getSessionUser: async () => sessionUser,
  getVerifiedSessionUser: async () =>
    sessionUser
      ? { ok: true, user: sessionUser }
      : { ok: false, reason: "unauthenticated" },
}));

mock.module("@/lib/db", () => ({
  getDb: () => fakeDb(),
  getPool: () => ({}),
  schema,
}));

mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => {
    if (!sessionUser) return { ok: false, reason: "unauthenticated" };
    const org = orgRows[0];
    if (!org) return { ok: false, reason: "not_found" };
    const membership = memberRows[0];
    if (!membership) return { ok: false, reason: "not_found" };
    return {
      ok: true,
      db: fakeDb(),
      user: sessionUser,
      org,
      membership: { id: 1, role: membership.role },
    };
  },
}));

mock.module("@/lib/finding-approvals", () => ({
  enqueueLatestGateStateSyncsForOrganization: async () => {
    organizationGateSyncJobs += 1;
  },
  enqueueGateStateSync: async () => {
    gateSyncJobs += 1;
  },
  findKindBlockingState: () => ({
    finding: {
      id: "finding",
      severity: authorDismissalAwaitingAcknowledgement ? "error" : "warn",
      kind: authorDismissalAwaitingAcknowledgement ? "risk" : "humanEscalation",
    },
    findingId: "finding",
    blocking:
      !approvalInserted &&
      (!dismissalActive || authorDismissalAwaitingAcknowledgement),
    activeApproval: approvalInserted ? { id: "approval-1" } : null,
    latestApproval: null,
    activeDismissal: dismissalActive
      ? {
          id: "dismissal-1",
          actorGithubId: authorDismissalAwaitingAcknowledgement ? "100" : "200",
        }
      : null,
    severityBlocking: authorDismissalAwaitingAcknowledgement,
    awaitingIndependentAck:
      authorDismissalAwaitingAcknowledgement && dismissalActive,
  }),
  findDismissibleFindingState: () => ({
    finding: { id: "finding", severity: "error", kind: "risk", confidence: 0.9 },
    findingId: "finding",
    activeApproval: null,
    activeDismissal: dismissalActive ? { id: "dismissal-1" } : null,
  }),
  formatRemainingGateBlockers: () => approvalInserted ? "No blocking findings remain." : "- finding",
  getReviewApprovalState: async () => ({
    effectiveGate: {
      failing:
        !approvalInserted &&
        (!dismissalActive || authorDismissalAwaitingAcknowledgement),
      blockers:
        approvalInserted ||
        (dismissalActive && !authorDismissalAwaitingAcknowledgement)
          ? []
          : [{}],
    },
  }),
  hasNewerCompletedReviewForHead: async () => false,
  hasNewerReviewForPr: async () => false,
  hasInFlightReviewForPr: async () => inFlightReview,
  insertFindingApproval: async (_db: unknown, input: { verb?: string }) => {
    approvalInserted = true;
    if (input.verb === "dismiss") dismissalActive = true;
    return "approval-1";
  },
  loadReviewForApprovalByPublicId: async () => approvalReview,
  lockActiveReviewState: async () => undefined,
  lockReviewApprovalState: async () => undefined,
  revokeFindingApproval: async (_db: unknown, _reviewId: number, _findingId: string, _userId: number, verb = "approve") => {
    if (verb === "dismiss") {
      if (!dismissalActive) return null;
      dismissalActive = false;
      return "dismissal-1";
    }
    if (!approvalInserted) return null;
    approvalInserted = false;
    return "approval-1";
  },
  updateStoredEffectiveGate: async (_db: unknown, _reviewId: number, failing: boolean) => {
    storedGateStates.push(failing);
  },
}));

mock.module("@/lib/gate-mode", () => ({
  lockOrganizationGateMode: async () => true,
}));

mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  buildAppJwt: () => "app-jwt",
  getAppJwt: () => "app-jwt",
  getInstallationToken: async () => "installation-token",
  normalizePrivateKey: (value: string) => value,
}));

mock.module("@/lib/github/approval-actor", () => ({
  loadLiveApprovalActor: async () => liveApprovalActor,
}));

mock.module("@/lib/github/checks", () => ({
  completeCheckRun: async (
    _token: string,
    _repo: string,
    _checkRunId: number,
    conclusion: string,
  ) => {
    checkConclusions.push(conclusion);
    if (checkError) throw checkError;
  },
  getPullRequestHeadSha: async () => approvalReview.headSha,
  getPullRequestReviewContext: async () => ({ authorGithubId: null }),
}));

mock.module("@/worker/runner", () => ({
  triggerQueueDrain: () => undefined,
}));

const orgSettingsActions = await import("@/app/orgs/[slug]/actions");
const {
  approveFinding,
  dismissFindingWithState,
  resendBillingContactVerification,
  revokeFinding,
  revokeFindingDismissalWithState,
  saveBillingContact,
  saveNotificationPreferences,
  saveOrgConfigFallbacks,
  saveOrgInferenceSettings,
  setOrgGateEnabled,
  setOrgSharedConfigEnabled,
} = orgSettingsActions;

function fakeDb() {
  return {
    select(selection: Record<string, unknown>) {
      const rows =
        "role" in selection
          ? memberRows
          : "billingSummaryEmail" in selection
            ? notificationPreferenceRows
          : "subscriptionMode" in selection
            ? billingRows
          : "activeEmail" in selection ||
              selection.pendingEmail === schema.organizationEntitlements.billingContactPending
            ? billingRows
          : "apiKeyCiphertext" in selection ||
              "pendingEmail" in selection ||
              "gateEnabled" in selection ||
              "sharedConfigEnabled" in selection
            ? settingsRows
            : orgRows;
      const chain = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
    insert(table: unknown) {
      insertCount += 1;
      return {
        values(values: Record<string, unknown>) {
          if (table === schema.jobs) {
            queuedJobs.push(values);
            return Promise.resolve([]);
          }
          if (table === schema.organizationSettingEvents) {
            settingEvents.push(...(Array.isArray(values) ? values : [values]));
            return {
              returning: async () => [{ id: 55 }],
            };
          }
          insertedValues = values;
          return {
            onConflictDoUpdate(args: { set: Record<string, unknown> }) {
              conflictSet = args.set;
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(fakeDb());
    },
    execute() {
      return Promise.resolve({ rows: billingRows });
    },
    update() {
      const chain = {
        set(values: Record<string, unknown>) {
          updatedValues = values;
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve(updateResultRows);
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve([]).then(resolve);
        },
      };
      return chain;
    },
  };
}

function settingsForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set("providerMode", "hosted");
  form.set("apiFormat", "openai-compatible");
  form.set("apiBase", "");
  form.set("model", "");
  form.set("modelCascade", "");
  form.set("apiKey", "");
  form.set("apiKeyAction", "keep");
  form.set("apiAuthHeader", "");
  form.set("apiAuthValue", "");
  form.set("apiAuthAction", "keep");
  form.set("configYaml", "");
  form.set("guardrailsMd", "");
  form.set("contentPolicyMd", "");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return form;
}

function byokForm(overrides: Record<string, string> = {}): FormData {
  return settingsForm({
    providerMode: "byok",
    apiBase: "https://11.0.0.1/v1",
    model: "provider-model",
    ...overrides,
  });
}

function toggleForm(name: string, value: string): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set(name, value);
  return form;
}

function approvalForm(): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set("publicId", "11111111-1111-4111-8111-111111111111");
  form.set("findingId", "finding");
  form.set("rationale", "reviewed");
  return form;
}

beforeEach(() => {
  delete process.env.POSTIL_HOSTED_INFERENCE_ENABLED;
  process.env.POSTIL_SEALING_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  sessionUser = { id: 10 };
  orgRows = [{ id: 20 }];
  memberRows = [{ role: "admin" }];
  insertedValues = null;
  conflictSet = null;
  insertCount = 0;
  settingsRows = [];
  billingRows = [];
  notificationPreferenceRows = [];
  queuedJobs = [];
  updatedValues = null;
  updateResultRows = [];
  approvalInserted = false;
  gateSyncJobs = 0;
  organizationGateSyncJobs = 0;
  settingEvents = [];
  storedGateStates = [];
  checkConclusions = [];
  checkError = null;
  liveApprovalActor = null;
  dismissalActive = false;
  authorDismissalAwaitingAcknowledgement = false;
  inFlightReview = false;
});

function dismissalForm(): FormData {
  const form = approvalForm();
  form.set("reasonTag", "false-positive");
  form.set("rationale", "The cited behavior is already handled by the changed code.");
  return form;
}

function billingContactForm(email: string): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set("billingContact", email);
  return form;
}

function notificationPreferencesForm(
  billingSummaryEmail: boolean,
  serviceSummaryEmail: boolean,
): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  if (billingSummaryEmail) form.set("billingSummaryEmail", "on");
  if (serviceSummaryEmail) form.set("serviceSummaryEmail", "on");
  return form;
}

describe("hosted overage administration", () => {
  test("does not expose a customer-controlled overage cap action", () => {
    expect("updateHostedOverageCap" in orgSettingsActions).toBe(false);
  });
});

describe("billing contact verification actions", () => {
  test("preserves the verified contact while a replacement waits for verification", async () => {
    billingRows = [{
      activeEmail: "accounts@example.com",
      pendingEmail: null,
      verifiedAt: new Date("2026-07-01T00:00:00.000Z"),
    }];
    updateResultRows = [{ orgId: 20 }];

    const result = await saveBillingContact(null, billingContactForm(" New@Example.COM "));

    expect(result).toEqual({
      status: "success",
      message: "Check your email to verify the replacement. The verified contact remains active.",
    });
    expect(updatedValues).toMatchObject({ billingContactPending: "new@example.com" });
    expect(updatedValues).not.toHaveProperty("billingContactEmail");
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ kind: "billing-contact-verification", maxAttempts: 5 });
  });

  test("does not send another email when the same address is already pending", async () => {
    billingRows = [{ activeEmail: null, pendingEmail: "billing@example.com", verifiedAt: null }];
    updateResultRows = [{ orgId: 20 }];

    const result = await saveBillingContact(null, billingContactForm("billing@example.com"));

    expect(result.message).toBe("Check your email to verify the billing contact.");
    expect(queuedJobs).toHaveLength(0);
  });

  test("resend requires a pending contact and enforces the cooldown", async () => {
    billingRows = [];
    expect(await resendBillingContactVerification(null, billingContactForm(""))).toMatchObject({
      status: "error",
    });

    billingRows = [{ pendingEmail: "billing@example.com", requestedAt: new Date() }];
    expect(await resendBillingContactVerification(null, billingContactForm(""))).toEqual({
      status: "error",
      message: "Wait a minute before sending another email.",
    });
    expect(queuedJobs).toHaveLength(0);
  });

  test("resend rotates the token and queues a durable job after the cooldown", async () => {
    billingRows = [{
      pendingEmail: "billing@example.com",
      requestedAt: new Date(Date.now() - 61_000),
    }];
    updateResultRows = [{ orgId: 20 }];

    expect(await resendBillingContactVerification(null, billingContactForm(""))).toEqual({
      status: "success",
      message: "Verification email queued.",
    });
    expect(updatedValues?.billingContactVerificationTokenDigest).toBeInstanceOf(Buffer);
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]?.kind).toBe("billing-contact-verification");
  });
});

describe("organization notification preferences", () => {
  test("stores optional email choices and audits changes", async () => {
    notificationPreferenceRows = [{
      billingSummaryEmail: true,
      serviceSummaryEmail: false,
    }];

    expect(
      await saveNotificationPreferences(
        null,
        notificationPreferencesForm(false, true),
      ),
    ).toEqual({
      status: "success",
      message: "Notification preferences saved.",
    });
    expect(insertedValues).toMatchObject({
      orgId: 20,
      billingSummaryEmail: false,
      serviceSummaryEmail: true,
    });
    expect(settingEvents).toEqual([
      {
        orgId: 20,
        setting: "billing_summary_email",
        value: "disabled",
        actorUserId: 10,
        source: "dashboard",
      },
      {
        orgId: 20,
        setting: "service_summary_email",
        value: "enabled",
        actorUserId: 10,
        source: "dashboard",
      },
    ]);
  });

  test("rejects non-admin preference changes", async () => {
    memberRows = [{ role: "member" }];

    await expect(
      saveNotificationPreferences(
        null,
        notificationPreferencesForm(false, false),
      ),
    ).rejects.toThrow("this action requires an organization admin");
    expect(insertCount).toBe(0);
  });
});

describe("organization settings actions", () => {
  test("audits a merge-gate change and queues organization-wide reconciliation", async () => {
    settingsRows = [{ gateEnabled: false }];

    const result = await setOrgGateEnabled(null, toggleForm("gateEnabled", "on"));

    expect(result.status).toBe("success");
    expect(conflictSet?.gateEnabled).toBe(true);
    expect(settingEvents).toEqual([{
      orgId: 20,
      setting: "gate_enabled",
      value: "enabled",
      actorUserId: 10,
      source: "dashboard",
    }]);
    expect(organizationGateSyncJobs).toBe(1);
  });

  test("does not audit or reconcile an unchanged gate mode", async () => {
    settingsRows = [{ gateEnabled: true }];

    const result = await setOrgGateEnabled(null, toggleForm("gateEnabled", "on"));

    expect(result.status).toBe("success");
    expect(conflictSet?.gateEnabled).toBe(true);
    expect(settingEvents).toEqual([]);
    expect(organizationGateSyncJobs).toBe(0);
  });

  test("rejects a non-admin merge-gate toggle", async () => {
    memberRows = [{ role: "member" }];

    await expect(setOrgGateEnabled(null, toggleForm("gateEnabled", "on"))).rejects.toThrow(
      "this action requires an organization admin",
    );
    expect(insertCount).toBe(0);
  });

  test("rejects invalid config YAML in the fallbacks save", async () => {
    const form = new FormData();
    form.set("slug", "acme");
    form.set("configYaml", "model:\n  name: local-model");

    const result = await saveOrgConfigFallbacks(null, form);

    expect(result.status).toBe("error");
    expect(result.message).toContain("cannot set model options");
    expect(insertCount).toBe(0);
  });

  test("rejects malformed and unsupported config values", async () => {
    for (const configYaml of [
      "[]\n",
      "futureOption: true\n",
      "gate:\n  blockOnKinds: risk\n",
      "gate:\n  blockOnKinds: [risk, unsupported]\n",
      "gate: blockOnKinds\n",
      "gate:\n  futureOption: true\n",
    ]) {
      const form = new FormData();
      form.set("slug", "acme");
      form.set("configYaml", configYaml);

      const result = await saveOrgConfigFallbacks(null, form);

      expect(result.status).toBe("error");
      expect(result.message.length).toBeGreaterThan(0);
      expect(insertCount).toBe(0);
    }
  });

  test("saves standard YAML core tags accepted by the CLI parser", async () => {
    const form = new FormData();
    const configYaml = `!!map
enabled: !!bool true
ignore: !!seq [!!str vendor/**]
minConfidence: !!float 0.8
maxFindings: !!int 20
reviewer: !!map
  tone: !!str terse
contentPolicy: !!map
  enabled: !!null null
`;
    form.set("slug", "acme");
    form.set("configYaml", configYaml);

    const result = await saveOrgConfigFallbacks(null, form);

    expect(result.status).toBe("success");
    expect(conflictSet).toMatchObject({ configYaml });
  });

  test("rejects custom and field-mismatched YAML tags in the fallbacks save", async () => {
    for (const configYaml of [
      "enabled: !custom true\n",
      "enabled: !<tag:example.com,2026:value> true\n",
      "enabled: !!str true\n",
      "ignore: !!map {entry: vendor/**}\n",
    ]) {
      const form = new FormData();
      form.set("slug", "acme");
      form.set("configYaml", configYaml);

      const result = await saveOrgConfigFallbacks(null, form);

      expect(result.status).toBe("error");
      expect(insertCount).toBe(0);
    }
  });

  test("saves every supported gate.blockOnKinds value without rewriting it", async () => {
    const form = new FormData();
    const configYaml = `gate:\n  failOn: error\n  blockOnKinds:\n${[
      "risk",
      "humanEscalation",
      "guardrail",
      "uncertainty",
      "contentPolicy",
    ]
      .map((kind) => `    - ${kind}`)
      .join("\n")}\nminConfidence: 0.8\nignore: [vendor/**]\n`;
    form.set("slug", "acme");
    form.set("configYaml", configYaml);

    const result = await saveOrgConfigFallbacks(null, form);

    expect(result.status).toBe("success");
    expect(conflictSet).toMatchObject({ configYaml });
  });

  test("saves CLI-compatible null, case-insensitive, and duplicate kind values verbatim", async () => {
    for (const configYaml of [
      "gate: null\n",
      "gate:\n  blockOnKinds: null\n",
      'gate:\n  blockOnKinds: [Risk, RISK, " humanEscalation ", ContentPolicy]\n',
    ]) {
      const form = new FormData();
      form.set("slug", "acme");
      form.set("configYaml", configYaml);

      const result = await saveOrgConfigFallbacks(null, form);

      expect(result.status).toBe("success");
      expect(conflictSet).toMatchObject({ configYaml });
    }
  });

  test("saves every CLI-supported non-model config field without rewriting it", async () => {
    const form = new FormData();
    const configYaml = `enabled: false
ignore: [vendor/**]
severityThreshold: warning
minConfidence: 0.8
maxFindings: 20
reviewer:
  tone: terse
  focus: [security]
review:
  onClean: comment
  findingPresentation: checkAnnotations
  uncertaintyResolution: false
  conciseFindings: false
gate:
  failOn: Never
  onError: advisory
  blockOnKinds: [Risk, risk]
contentPolicy:
  enabled: false
`;
    form.set("slug", "acme");
    form.set("configYaml", configYaml);

    const result = await saveOrgConfigFallbacks(null, form);

    expect(result.status).toBe("success");
    expect(conflictSet).toMatchObject({ configYaml });
  });

  test("saves config fallback texts without touching provider settings", async () => {
    const form = new FormData();
    form.set("slug", "acme");
    form.set("configYaml", "minConfidence: 0.8\n");
    form.set("guardrailsMd", "");
    form.set("contentPolicyMd", "No hype.");

    const result = await saveOrgConfigFallbacks(null, form);

    expect(result).toEqual({ status: "success", message: "Config fallbacks saved." });
    expect(conflictSet).toMatchObject({
      configYaml: "minConfidence: 0.8\n",
      guardrailsMd: null,
      contentPolicyMd: "No hype.",
    });
    expect(conflictSet).not.toHaveProperty("apiBase");
    expect(conflictSet).not.toHaveProperty("gateEnabled");
  });

  test("rejects non-admin writes before storing settings", async () => {
    memberRows = [{ role: "member" }];

    await expect(saveOrgInferenceSettings(null, settingsForm())).rejects.toThrow(
      "this action requires an organization admin",
    );
    expect(insertCount).toBe(0);
  });

  test("rejects non-admin finding approvals before storing approval state", async () => {
    memberRows = [{ role: "member" }];

    await expect(approveFinding(approvalForm())).rejects.toThrow(
      "this action requires an organization admin",
    );
    expect(insertCount).toBe(0);
  });

  test("queues durable GitHub gate synchronization with a dashboard approval", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    liveApprovalActor = {
      userId: 10,
      githubId: "100",
      login: "owner",
      role: "admin",
    };

    await approveFinding(approvalForm());

    expect(storedGateStates).toEqual([false]);
    expect(gateSyncJobs).toBe(1);
  });

  test("allows a different admin to acknowledge an author self-dismissal", async () => {
    sessionUser = { id: 11, githubId: "200", login: "admin" };
    liveApprovalActor = {
      userId: 11,
      githubId: "200",
      login: "admin",
      role: "admin",
    };
    dismissalActive = true;
    authorDismissalAwaitingAcknowledgement = true;

    await approveFinding(approvalForm());

    expect(dismissalActive).toBe(false);
    expect(approvalInserted).toBe(true);
    expect(storedGateStates).toEqual([false]);
    expect(gateSyncJobs).toBe(1);
  });

  test("rejects an author acknowledging their own dismissal", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    liveApprovalActor = {
      userId: 10,
      githubId: "100",
      login: "owner",
      role: "admin",
    };
    dismissalActive = true;
    authorDismissalAwaitingAcknowledgement = true;

    await expect(approveFinding(approvalForm())).rejects.toThrow(
      "the pull request author's dismissal requires acknowledgement from a different organization admin",
    );

    expect(dismissalActive).toBe(true);
    expect(approvalInserted).toBe(false);
    expect(storedGateStates).toEqual([]);
    expect(gateSyncJobs).toBe(0);
  });

  test("requires live GitHub admin verification for a dashboard approval", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };

    await expect(approveFinding(approvalForm())).rejects.toThrow(
      "GitHub could not verify this account as an active organization admin",
    );
    expect(approvalInserted).toBe(false);
    expect(gateSyncJobs).toBe(0);
  });

  test("restores blocking when an acknowledged author dismissal is revoked", async () => {
    sessionUser = { id: 11, githubId: "200", login: "admin" };
    liveApprovalActor = {
      userId: 11,
      githubId: "200",
      login: "admin",
      role: "admin",
    };
    dismissalActive = true;
    authorDismissalAwaitingAcknowledgement = true;

    await approveFinding(approvalForm());
    await revokeFinding(approvalForm());

    expect(approvalInserted).toBe(false);
    expect(storedGateStates).toEqual([false, true]);
    expect(gateSyncJobs).toBe(2);
  });

  test("requires live GitHub admin verification for a dashboard dismissal", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };

    const result = await dismissFindingWithState(
      { status: "idle", message: "" },
      dismissalForm(),
    );

    expect(result).toEqual({
      status: "error",
      message: "GitHub could not verify this account as an active organization admin",
    });
    expect(dismissalActive).toBe(false);
  });

  test("queues gate synchronization after a live-admin dashboard dismissal", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    liveApprovalActor = { userId: 10, githubId: "100", login: "owner", role: "admin" };

    const result = await dismissFindingWithState(
      { status: "idle", message: "" },
      dismissalForm(),
    );

    expect(result.status).toBe("success");
    expect(dismissalActive).toBe(true);
    expect(gateSyncJobs).toBe(1);
  });

  test("live-verifies dismissal revocation and restores the gate", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    liveApprovalActor = { userId: 10, githubId: "100", login: "owner", role: "admin" };
    dismissalActive = true;

    const result = await revokeFindingDismissalWithState(
      { status: "idle", message: "" },
      dismissalForm(),
    );

    expect(result.status).toBe("success");
    expect(dismissalActive).toBe(false);
    expect(storedGateStates).toEqual([true]);
    expect(gateSyncJobs).toBe(1);
  });

  test("rejects dismissal revocation while a review is in progress", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    liveApprovalActor = { userId: 10, githubId: "100", login: "owner", role: "admin" };
    dismissalActive = true;
    inFlightReview = true;

    const result = await revokeFindingDismissalWithState(
      { status: "idle", message: "" },
      dismissalForm(),
    );

    expect(result).toEqual({
      status: "error",
      message: "a review is in progress; re-issue after it completes",
    });
    expect(dismissalActive).toBe(true);
    expect(gateSyncJobs).toBe(0);
  });

  test("queues durable GitHub gate synchronization with a dashboard revocation", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    approvalInserted = true;

    await revokeFinding(approvalForm());

    expect(storedGateStates).toEqual([true]);
    expect(gateSyncJobs).toBe(1);
    expect(checkConclusions).toEqual([]);
  });

  test("rejects approval revocation while a review is in progress", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    approvalInserted = true;
    inFlightReview = true;

    await expect(revokeFinding(approvalForm())).rejects.toThrow(
      "a review is in progress; re-issue after it completes",
    );
    expect(approvalInserted).toBe(true);
    expect(gateSyncJobs).toBe(0);
  });

  test("commits revocation before durable GitHub synchronization", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    approvalInserted = true;
    checkError = new Error("GitHub unavailable");

    await revokeFinding(approvalForm());

    expect(approvalInserted).toBe(false);
    expect(storedGateStates).toEqual([true]);
    expect(gateSyncJobs).toBe(1);
  });

  test("seals a replacement API key before storage", async () => {
    const result = await saveOrgInferenceSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );

    expect(result).toEqual({ status: "success", message: "Inference settings saved." });
    const ciphertext = insertedValues?.apiKeyCiphertext;
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    const sealed = ciphertext as Buffer;
    expect(sealed.toString("utf8")).not.toContain("sk-test-secret");
    expect(unseal(sealed, Buffer.from(process.env.POSTIL_SEALING_KEY!, "hex"))).toBe(
      "sk-test-secret",
    );
    expect(conflictSet?.apiKeyCiphertext).toBe(sealed);
    expect(conflictSet).not.toHaveProperty("sharedConfigEnabled");
    expect(conflictSet).not.toHaveProperty("configYaml");
  });

  test("lets an admin disable shared owner configuration", async () => {
    settingsRows = [{ sharedConfigEnabled: true }];

    const result = await setOrgSharedConfigEnabled(
      null,
      toggleForm("sharedConfigEnabled", "off"),
    );

    expect(result.status).toBe("success");
    expect(conflictSet?.sharedConfigEnabled).toBe(false);
    expect(settingEvents).toEqual([{
      orgId: 20,
      setting: "shared_config_enabled",
      value: "disabled",
      actorUserId: 10,
      source: "dashboard",
    }]);
  });

  test("preserves an existing write-only key when no key action is requested", async () => {
    settingsRows = [{ apiKeyCiphertext: Buffer.from("existing") }];
    await saveOrgInferenceSettings(null, byokForm({ model: "org-model" }));

    expect(insertedValues?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).not.toHaveProperty("apiKeyCiphertext");
    expect(conflictSet).toMatchObject({ model: "org-model" });
  });

  test("does not convert keep plus a typed key into an implicit replacement", async () => {
    settingsRows = [{ apiKeyCiphertext: Buffer.from("existing") }];
    await saveOrgInferenceSettings(
      null,
      byokForm({ apiKeyAction: "keep", apiKey: "sk-ignored-secret" }),
    );

    expect(insertedValues?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).not.toHaveProperty("apiKeyCiphertext");
  });

  test("clears every provider field atomically when BYOK is removed", async () => {
    await saveOrgInferenceSettings(null, settingsForm({ apiKeyAction: "remove" }));

    expect(conflictSet?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).toMatchObject({
      apiBase: null,
      apiFormat: "openai-compatible",
      model: null,
      modelCascade: null,
      apiAuthHeaderCiphertext: null,
      apiAuthValueCiphertext: null,
    });
  });

  test("rejects replace without a new key", async () => {
    const result = await saveOrgInferenceSettings(null, byokForm({ apiKeyAction: "replace" }));

    expect(result).toEqual({
      status: "error",
      message: "Enter a new API key before replacing the stored key.",
    });
    expect(insertCount).toBe(0);
  });

  test("does not accept or store provider overrides in hosted mode", async () => {
    await expect(
      saveOrgInferenceSettings(null, settingsForm({ apiBase: "http://127.0.0.1/v1" })),
    ).resolves.toMatchObject({ status: "success" });
    expect(conflictSet?.apiBase).toBeNull();
  });

  test("rejects invalid provider API bases in BYOK mode before storage", async () => {
    await expect(
      saveOrgInferenceSettings(
        null,
        byokForm({ apiKeyAction: "replace", apiKey: "key", apiBase: "http://127.0.0.1/v1" }),
      ),
    ).rejects.toThrow("API base URL must use https:");
    expect(insertCount).toBe(0);
  });

  test("seals optional additional authentication name and value", async () => {
    await saveOrgInferenceSettings(
      null,
      byokForm({
        apiKeyAction: "replace",
        apiKey: "provider-key",
        apiAuthAction: "replace",
        apiAuthHeader: "CF-Access-Client-Secret",
        apiAuthValue: "gateway-secret",
      }),
    );

    const key = Buffer.from(process.env.POSTIL_SEALING_KEY!, "hex");
    expect(unseal(conflictSet?.apiAuthHeaderCiphertext as Buffer, key)).toBe(
      "CF-Access-Client-Secret",
    );
    expect(unseal(conflictSet?.apiAuthValueCiphertext as Buffer, key)).toBe("gateway-secret");
  });

  for (const header of ["x-api-key", "Content-Type", "X-Forwarded-For"]) {
    test(`rejects reserved additional auth header ${header}`, async () => {
      await expect(
        saveOrgInferenceSettings(
          null,
          byokForm({
            apiKeyAction: "replace",
            apiKey: "provider-key",
            apiAuthAction: "replace",
            apiAuthHeader: header,
            apiAuthValue: "gateway-secret",
          }),
        ),
      ).rejects.toThrow("conflicts with a provider or transport header");
      expect(insertCount).toBe(0);
    });
  }

  test("rejects Authorization as additional auth for OpenAI-compatible APIs", async () => {
    await expect(
      saveOrgInferenceSettings(
        null,
        byokForm({
          apiKeyAction: "replace",
          apiKey: "provider-key",
          apiAuthAction: "replace",
          apiAuthHeader: "Authorization",
          apiAuthValue: "Bearer gateway-secret",
        }),
      ),
    ).rejects.toThrow("conflicts with a provider or transport header");
  });

  test("allows sealed Authorization auth for Anthropic APIs", async () => {
    await saveOrgInferenceSettings(
      null,
      byokForm({
        apiFormat: "anthropic",
        apiKeyAction: "replace",
        apiKey: "provider-key",
        apiAuthAction: "replace",
        apiAuthHeader: "Authorization",
        apiAuthValue: "Bearer gateway-secret",
      }),
    );

    const key = Buffer.from(process.env.POSTIL_SEALING_KEY!, "hex");
    expect(unseal(conflictSet?.apiAuthHeaderCiphertext as Buffer, key)).toBe("Authorization");
  });

  test("rejects keeping Anthropic Authorization auth when switching to OpenAI-compatible", async () => {
    const key = Buffer.from(process.env.POSTIL_SEALING_KEY!, "hex");
    settingsRows = [
      {
        apiKeyCiphertext: Buffer.from("existing"),
        apiAuthHeaderCiphertext: seal("Authorization", key),
      },
    ];

    await expect(
      saveOrgInferenceSettings(
        null,
        byokForm({ apiFormat: "openai-compatible", apiAuthAction: "keep" }),
      ),
    ).rejects.toThrow("conflicts with a provider or transport header");
    expect(insertCount).toBe(0);
  });

  test("rejects multiline additional authentication values", async () => {
    await expect(
      saveOrgInferenceSettings(
        null,
        byokForm({
          apiKeyAction: "replace",
          apiKey: "provider-key",
          apiAuthAction: "replace",
          apiAuthHeader: "X-Gateway-Key",
          apiAuthValue: "first\nInjected: second",
        }),
      ),
    ).rejects.toThrow("must be one line");
    expect(insertCount).toBe(0);
  });

  test("rejects BYOK keep when no stored key exists", async () => {
    const result = await saveOrgInferenceSettings(null, byokForm());
    expect(result).toEqual({ status: "error", message: "Enter a provider key to enable BYOK." });
    expect(insertCount).toBe(0);
  });

  test("rejects an inference mode that conflicts with the billed plan", async () => {
    billingRows = [{ subscriptionMode: "hosted" }];
    const result = await saveOrgInferenceSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );
    expect(result).toEqual({
      status: "error",
      message: "Your plan uses hosted inference. Change the plan before switching inference mode.",
    });
    expect(insertCount).toBe(0);
  });

  test("lets an active trial switch from hosted inference to BYOK atomically", async () => {
    billingRows = [{
      subscriptionMode: "hosted",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 60_000),
    }];
    updateResultRows = [{ orgId: 20 }];

    const result = await saveOrgInferenceSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );

    expect(result).toEqual({ status: "success", message: "Inference settings saved." });
    expect(updatedValues).toMatchObject({
      subscriptionMode: "byok",
      updatedBy: "trial-provider-mode",
    });
    expect(conflictSet).toHaveProperty("apiKeyCiphertext");
  });

  test("writes the requested mode even when an active trial already has that mode", async () => {
    billingRows = [{
      subscriptionMode: "byok",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 60_000),
    }];
    updateResultRows = [{ orgId: 20 }];

    const result = await saveOrgInferenceSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );

    expect(result).toEqual({ status: "success", message: "Inference settings saved." });
    expect(updatedValues).toMatchObject({
      subscriptionMode: "byok",
      updatedBy: "trial-provider-mode",
    });
  });

  test("does not let an expired trial change provider mode", async () => {
    billingRows = [{
      subscriptionMode: "hosted",
      status: "trialing",
      trialEndsAt: new Date(Date.now() - 60_000),
    }];

    const result = await saveOrgInferenceSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Your plan uses hosted inference. Change the plan before switching inference mode.",
    });
    expect(insertCount).toBe(0);
  });

  test("does not let a BYOK trial select hosted inference while hosted is paused", async () => {
    process.env.POSTIL_HOSTED_INFERENCE_ENABLED = "0";
    billingRows = [{
      subscriptionMode: "byok",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 60_000),
    }];

    const result = await saveOrgInferenceSettings(null, settingsForm());

    expect(result).toEqual({
      status: "error",
      message: "Hosted inference is paused. Use your provider.",
    });
    expect(insertCount).toBe(0);
  });

});

describe("SettingsForm API key handling", () => {
  test("renders the key input as write-only password state", () => {
    const source = readFileSync("src/app/orgs/[slug]/settings-form.tsx", "utf8");

    expect(source).toContain('type="password"');
    expect(source).toContain('name="apiKey"');
    expect(source).toContain("Hosted by Postil");
    expect(source).toContain("Postil chooses and operates the models.");
    expect(source).toContain("Use your provider");
    expect(source).toContain("Choose the request format your API accepts.");
    expect(source).toContain("Provider credentials are stored encrypted and never shown again.");
    expect(source).toContain('value="openai-compatible"');
    expect(source).toContain('value="anthropic"');
    expect(source).toContain('type="checkbox"');
    expect(source).toContain('type="radio"');
    expect(source).toContain("!hostedInferenceAvailable");
    expect(readFileSync("src/app/orgs/[slug]/actions.ts", "utf8")).toContain("FOR UPDATE");
    expect(source).toContain('disabled={billedMode === "hosted" && !trialCanSwitchProvider}');
    expect(source).toContain("New hosted inference setup is unavailable.");
    expect(source).toContain("Choose hosted inference or your provider during the free trial.");
    expect(source).toContain("Use only a provider you trust with that code.");
    expect(source).toContain("Private repositories remain inactive until a matching plan");
    expect(source).toContain("Shared owner configuration is disabled. The stored snapshot is not used.");
    expect(source).toContain("No verified shared snapshot is available.");
    expect(source).toContain("The App installation does not include");
    expect(source).toContain("Protect its default branch with CODEOWNERS, a ruleset, and required review.");
    expect(source).not.toContain("CONFIG_FALLBACKS_SAVE_DEBOUNCE_MS");
    expect(source).not.toContain("clearTimeout(timer)");
    expect(source).not.toContain("defaultValue={settings?.apiKey");
    expect(source).not.toContain("value={settings?.apiKey");
    expect(source).not.toContain("HOSTED_DEFAULT_MODEL_CHAIN");
  });

  test("does not expose a second escalation channel outside the pull request", () => {
    const formSource = readFileSync("src/app/orgs/[slug]/settings-form.tsx", "utf8");
    const pageSource = readFileSync("src/app/orgs/[slug]/settings/page.tsx", "utf8");

    expect(formSource).not.toContain("Escalation emails");
    expect(formSource).not.toContain("escalationEmail");
    expect(pageSource).not.toContain("emailVerification");
    expect(pageSource).toContain("Shared owner configuration supplies");
  });
});
