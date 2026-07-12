import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { seal, unseal } from "@/lib/crypto/seal";

let sessionUser: { id: number } | null = { id: 10 };
let orgRows: Array<{ id: number }> = [{ id: 20 }];
let memberRows: Array<{ role: string }> = [{ role: "admin" }];
let settingsRows: Array<{
  apiKeyCiphertext: Buffer | null;
  apiAuthHeaderCiphertext?: Buffer | null;
}> = [];
let insertedValues: Record<string, unknown> | null = null;
let conflictSet: Record<string, unknown> | null = null;
let insertCount = 0;

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
  },
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

const { approveFinding, saveOrgSettings } = await import("@/app/orgs/[slug]/actions");

function fakeDb() {
  return {
    select(selection: Record<string, unknown>) {
      const rows = "role" in selection
        ? memberRows
        : "apiKeyCiphertext" in selection
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
    insert() {
      insertCount += 1;
      return {
        values(values: Record<string, unknown>) {
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
  settingsRows = [];
  insertedValues = null;
  conflictSet = null;
  insertCount = 0;
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

    expect(result.status).toBe("success");
    expect(conflictSet?.escalationEmail).toBe("owners@example.com");
  });

  test("rejects malformed escalation recipients", async () => {
    const result = await saveOrgSettings(
      null,
      settingsForm({ escalationEmail: "not-an-email" }),
    );

    expect(result).toEqual({
      status: "error",
      message: "Enter a valid escalation email address.",
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
    expect(source).toContain("Stored encrypted and never shown again.");
    expect(source).toContain('value="openai-compatible"');
    expect(source).toContain('value="anthropic"');
    expect(source).toContain('type="checkbox"');
    expect(source).toContain('type="radio"');
    expect(source).not.toContain("defaultValue={settings?.apiKey");
    expect(source).not.toContain("value={settings?.apiKey");
    expect(source).not.toContain("HOSTED_DEFAULT_MODEL_CHAIN");
  });
});
