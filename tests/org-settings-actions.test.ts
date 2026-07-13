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
let queuedJobs: Array<Record<string, unknown>> = [];
let updatedValues: Record<string, unknown> | null = null;
let updateResultRows: Array<Record<string, unknown>> = [];
let approvalInserted = false;
let gateSyncJobs = 0;
let storedGateStates: boolean[] = [];
let checkConclusions: string[] = [];
let checkError: Error | null = null;

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
    apiKeyCiphertext: "org_settings.api_key_ciphertext",
    apiAuthHeaderCiphertext: "org_settings.api_auth_header_ciphertext",
    updatedAt: "org_settings.updated_at",
  },
  organizationEntitlements: {
    orgId: "organization_entitlements.org_id",
    subscriptionMode: "organization_entitlements.subscription_mode",
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
  jobs: { kind: "jobs.kind" },
};

mock.module("next/cache", () => ({
  revalidatePath: () => undefined,
}));

mock.module("@/lib/session", () => ({
  getSessionUser: async () => sessionUser,
}));

mock.module("@/lib/db", () => ({
  getDb: () => fakeDb(),
  schema,
}));

mock.module("@/lib/finding-approvals", () => ({
  enqueueGateStateSync: async () => {
    gateSyncJobs += 1;
  },
  findKindBlockingState: () => ({
    finding: { id: "finding", severity: "warn", kind: "humanEscalation" },
    findingId: "finding",
    blocking: true,
    activeApproval: approvalInserted ? { id: "approval-1" } : null,
    latestApproval: null,
    severityBlocking: false,
  }),
  formatRemainingGateBlockers: () => approvalInserted ? "No blocking findings remain." : "- finding",
  getReviewApprovalState: async () => ({
    effectiveGate: { failing: !approvalInserted, blockers: approvalInserted ? [] : [{}] },
  }),
  hasNewerCompletedReviewForHead: async () => false,
  insertFindingApproval: async () => {
    approvalInserted = true;
    return "approval-1";
  },
  loadReviewForApprovalByPublicId: async () => approvalReview,
  lockReviewApprovalState: async () => undefined,
  revokeFindingApproval: async () => {
    if (!approvalInserted) return null;
    approvalInserted = false;
    return "approval-1";
  },
  updateStoredEffectiveGate: async (_db: unknown, _reviewId: number, failing: boolean) => {
    storedGateStates.push(failing);
  },
}));

mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  getInstallationToken: async () => "installation-token",
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
}));

mock.module("@/worker/runner", () => ({
  triggerQueueDrain: () => undefined,
}));

const {
  approveFinding,
  resendBillingContactVerification,
  revokeFinding,
  saveBillingContact,
  saveOrgSettings,
} = await import("@/app/orgs/[slug]/actions");

function fakeDb() {
  return {
    select(selection: Record<string, unknown>) {
      const rows =
        "role" in selection
          ? memberRows
          : "subscriptionMode" in selection
            ? billingRows
          : "activeEmail" in selection ||
              selection.pendingEmail === schema.organizationEntitlements.billingContactPending
            ? billingRows
          : "apiKeyCiphertext" in selection || "pendingEmail" in selection
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

function approvalForm(): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set("publicId", "11111111-1111-4111-8111-111111111111");
  form.set("findingId", "finding");
  form.set("rationale", "reviewed");
  return form;
}

beforeEach(() => {
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
  queuedJobs = [];
  updatedValues = null;
  updateResultRows = [];
  approvalInserted = false;
  gateSyncJobs = 0;
  storedGateStates = [];
  checkConclusions = [];
  checkError = null;
});

function billingContactForm(email: string): FormData {
  const form = new FormData();
  form.set("slug", "acme");
  form.set("billingContact", email);
  return form;
}

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

describe("saveOrgSettings", () => {
  test("rejects non-admin writes before storing settings", async () => {
    memberRows = [{ role: "member" }];

    await expect(saveOrgSettings(null, settingsForm())).rejects.toThrow(
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

    await approveFinding(approvalForm());

    expect(storedGateStates).toEqual([false]);
    expect(gateSyncJobs).toBe(1);
  });

  test("queues durable GitHub gate synchronization with a dashboard revocation", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    approvalInserted = true;

    await revokeFinding(approvalForm());

    expect(storedGateStates).toEqual([true]);
    expect(gateSyncJobs).toBe(1);
    expect(checkConclusions).toEqual(["failure"]);
  });

  test("keeps the approval active when fail-closed revocation cannot reach GitHub", async () => {
    sessionUser = { id: 10, githubId: "100", login: "owner" };
    approvalInserted = true;
    checkError = new Error("GitHub unavailable");

    await expect(revokeFinding(approvalForm())).rejects.toThrow("GitHub unavailable");

    expect(approvalInserted).toBe(true);
    expect(storedGateStates).toEqual([]);
    expect(gateSyncJobs).toBe(0);
  });

  test("seals a replacement API key before storage", async () => {
    const result = await saveOrgSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );

    expect(result).toEqual({ status: "success", message: "Organization settings saved." });
    const ciphertext = insertedValues?.apiKeyCiphertext;
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    const sealed = ciphertext as Buffer;
    expect(sealed.toString("utf8")).not.toContain("sk-test-secret");
    expect(unseal(sealed, Buffer.from(process.env.POSTIL_SEALING_KEY!, "hex"))).toBe(
      "sk-test-secret",
    );
    expect(conflictSet?.apiKeyCiphertext).toBe(sealed);
    expect(conflictSet?.sharedConfigEnabled).toBe(true);
  });

  test("lets an admin disable shared owner configuration", async () => {
    const form = byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" });
    form.set("sharedConfigEnabled", "off");

    await saveOrgSettings(null, form);

    expect(conflictSet?.sharedConfigEnabled).toBe(false);
  });

  test("preserves an existing write-only key when no key action is requested", async () => {
    settingsRows = [{ apiKeyCiphertext: Buffer.from("existing") }];
    await saveOrgSettings(null, byokForm({ model: "org-model" }));

    expect(insertedValues?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).not.toHaveProperty("apiKeyCiphertext");
    expect(conflictSet).toMatchObject({ model: "org-model" });
  });

  test("does not convert keep plus a typed key into an implicit replacement", async () => {
    settingsRows = [{ apiKeyCiphertext: Buffer.from("existing") }];
    await saveOrgSettings(
      null,
      byokForm({ apiKeyAction: "keep", apiKey: "sk-ignored-secret" }),
    );

    expect(insertedValues?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).not.toHaveProperty("apiKeyCiphertext");
  });

  test("clears every provider field atomically when BYOK is removed", async () => {
    await saveOrgSettings(null, settingsForm({ apiKeyAction: "remove" }));

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
    const result = await saveOrgSettings(null, byokForm({ apiKeyAction: "replace" }));

    expect(result).toEqual({
      status: "error",
      message: "Enter a new API key before replacing the stored key.",
    });
    expect(insertCount).toBe(0);
  });

  test("does not accept or store provider overrides in hosted mode", async () => {
    await expect(
      saveOrgSettings(null, settingsForm({ apiBase: "http://127.0.0.1/v1" })),
    ).resolves.toMatchObject({ status: "success" });
    expect(conflictSet?.apiBase).toBeNull();
  });

  test("rejects invalid provider API bases in BYOK mode before storage", async () => {
    await expect(
      saveOrgSettings(
        null,
        byokForm({ apiKeyAction: "replace", apiKey: "key", apiBase: "http://127.0.0.1/v1" }),
      ),
    ).rejects.toThrow("API base URL must use https:");
    expect(insertCount).toBe(0);
  });

  test("seals optional additional authentication name and value", async () => {
    await saveOrgSettings(
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
        saveOrgSettings(
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
      saveOrgSettings(
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
    await saveOrgSettings(
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
      saveOrgSettings(
        null,
        byokForm({ apiFormat: "openai-compatible", apiAuthAction: "keep" }),
      ),
    ).rejects.toThrow("conflicts with a provider or transport header");
    expect(insertCount).toBe(0);
  });

  test("rejects multiline additional authentication values", async () => {
    await expect(
      saveOrgSettings(
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
    const result = await saveOrgSettings(null, byokForm());
    expect(result).toEqual({ status: "error", message: "Enter a provider key to enable BYOK." });
    expect(insertCount).toBe(0);
  });

  test("rejects an inference mode that conflicts with the billed plan", async () => {
    billingRows = [{ subscriptionMode: "hosted" }];
    const result = await saveOrgSettings(
      null,
      byokForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
    );
    expect(result).toEqual({
      status: "error",
      message: "Your billed plan uses hosted inference. Contact Postil before switching inference mode.",
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
    expect(source).toContain('disabled={billedMode === "byok"}');
    expect(source).toContain('disabled={billedMode === "hosted"}');
    expect(source).toContain("Private repositories remain inactive until a matching plan");
    expect(source).toContain("Shared owner configuration is disabled. The stored snapshot is not used.");
    expect(source).toContain("Protect its default branch with CODEOWNERS, a ruleset, and required review.");
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
  });
});
