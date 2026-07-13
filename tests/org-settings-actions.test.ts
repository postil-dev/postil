import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { seal, unseal } from "@/lib/crypto/seal";

let sessionUser: { id: number } | null = { id: 10 };
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
    escalationEmail: "org_settings.escalation_email",
    escalationEmailPending: "org_settings.escalation_email_pending",
    escalationEmailVerifiedAt: "org_settings.escalation_email_verified_at",
    escalationEmailVerificationRequestedAt:
      "org_settings.escalation_email_verification_requested_at",
    escalationEmailVerificationTokenDigest:
      "org_settings.escalation_email_verification_token_digest",
    escalationEmailVerificationTokenCiphertext:
      "org_settings.escalation_email_verification_token_ciphertext",
    escalationEmailVerificationExpiresAt:
      "org_settings.escalation_email_verification_expires_at",
    escalationEmailVerificationSentAt:
      "org_settings.escalation_email_verification_sent_at",
    escalationEmailVerificationMessageId:
      "org_settings.escalation_email_verification_message_id",
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

const {
  approveFinding,
  resendBillingContactVerification,
  resendEscalationEmailVerification,
  saveBillingContact,
  saveOrgSettings,
} = await import("@/app/orgs/[slug]/actions");

function fakeDb() {
  return {
    select(selection: Record<string, unknown>) {
      const rows =
        "role" in selection
          ? memberRows
          : "activeEmail" in selection ||
              selection.pendingEmail === schema.organizationEntitlements.billingContactPending
            ? billingRows
          : "apiKeyCiphertext" in selection ||
              "escalationEmail" in selection ||
              "pendingEmail" in selection
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
  form.set("escalationEmail", "");
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

  test("stores an organization-scoped escalation recipient", async () => {
    const result = await saveOrgSettings(
      null,
      settingsForm({ escalationEmail: "owners@example.com" }),
    );

    expect(result).toEqual({
      status: "success",
      message: "Settings saved. Check your email to verify notifications.",
    });
    expect(conflictSet?.escalationEmailPending).toBe("owners@example.com");
    expect(conflictSet?.escalationEmail).toBeNull();
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]).toMatchObject({ kind: "escalation-email-verification" });
    expect(JSON.stringify(queuedJobs[0])).not.toContain("owners@example.com");
  });

  test("rejects malformed escalation recipients", async () => {
    const result = await saveOrgSettings(
      null,
      settingsForm({ escalationEmail: "not-an-email" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Enter a valid notification email.",
    });
    expect(insertCount).toBe(0);
  });

  test("keeps the verified address active while a replacement waits", async () => {
    settingsRows = [
      {
        escalationEmail: "verified@example.com",
        escalationEmailPending: null,
        escalationEmailVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];
    await saveOrgSettings(
      null,
      settingsForm({ escalationEmail: "Replacement@Example.com" }),
    );

    expect(conflictSet?.escalationEmail).toBeUndefined();
    expect(conflictSet?.escalationEmailVerifiedAt).toBeUndefined();
    expect(conflictSet?.escalationEmailPending).toBe("replacement@example.com");
    expect(queuedJobs).toHaveLength(1);
  });

  test("removing an address clears active, pending, and token state", async () => {
    settingsRows = [
      {
        escalationEmail: "verified@example.com",
        escalationEmailPending: "replacement@example.com",
        escalationEmailVerifiedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];
    await saveOrgSettings(null, settingsForm({ escalationEmail: "" }));

    expect(conflictSet).toMatchObject({
      escalationEmail: null,
      escalationEmailPending: null,
      escalationEmailVerifiedAt: null,
      escalationEmailVerificationTokenDigest: null,
      escalationEmailVerificationTokenCiphertext: null,
    });
    expect(queuedJobs).toHaveLength(0);
  });

  test("does not queue another email when the same address is already pending", async () => {
    settingsRows = [
      {
        escalationEmail: null,
        escalationEmailPending: "pending@example.com",
        escalationEmailVerifiedAt: null,
      },
    ];
    await saveOrgSettings(
      null,
      settingsForm({ escalationEmail: "PENDING@example.com" }),
    );
    expect(queuedJobs).toHaveLength(0);
    expect(conflictSet?.escalationEmailPending).toBeUndefined();
  });

  test("resend enforces cooldown without queuing", async () => {
    settingsRows = [
      {
        pendingEmail: "pending@example.com",
        requestedAt: new Date(),
      },
    ];
    const form = new FormData();
    form.set("slug", "acme");
    expect(await resendEscalationEmailVerification(null, form)).toEqual({
      status: "error",
      message: "Wait a minute before sending another email.",
    });
    expect(queuedJobs).toHaveLength(0);
    expect(updatedValues).toBeNull();
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
    expect(source).not.toContain("defaultValue={settings?.apiKey");
    expect(source).not.toContain("value={settings?.apiKey");
    expect(source).not.toContain("HOSTED_DEFAULT_MODEL_CHAIN");
  });

  test("renders minimal pending and verified notification states", () => {
    const formSource = readFileSync("src/app/orgs/[slug]/settings-form.tsx", "utf8");
    const pageSource = readFileSync("src/app/orgs/[slug]/settings/page.tsx", "utf8");

    expect(formSource).toContain("Check your email to verify this address.");
    expect(formSource).toContain("Escalation emails");
    expect(formSource).toContain(
      "Get an email when a finding needs human attention.",
    );
    expect(formSource).toContain("Alerts continue to the verified address.");
    expect(formSource).toContain("Resend");
    expect(formSource).toContain("verified");
    expect(pageSource).toContain('role="status"');
    expect(pageSource).toContain('role="alert"');
    expect(pageSource).toContain("Notification email verified.");
    expect(pageSource).toContain("This verification link is invalid or expired.");
  });
});
