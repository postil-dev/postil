import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { unseal } from "@/lib/crypto/seal";

let sessionUser: { id: number } | null = { id: 10 };
let orgRows: Array<{ id: number }> = [{ id: 20 }];
let memberRows: Array<{ role: string }> = [{ role: "admin" }];
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
      const rows = "role" in selection ? memberRows : orgRows;
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
  form.set("apiBase", "");
  form.set("model", "");
  form.set("modelCascade", "");
  form.set("apiKey", "");
  form.set("apiKeyAction", "keep");
  form.set("configYaml", "");
  form.set("guardrailsMd", "");
  form.set("contentPolicyMd", "");
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
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
  process.env.POSTIL_SEALING_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
  sessionUser = { id: 10 };
  orgRows = [{ id: 20 }];
  memberRows = [{ role: "admin" }];
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
      settingsForm({ apiKeyAction: "replace", apiKey: "sk-test-secret" }),
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
    await saveOrgSettings(null, settingsForm({ model: "org-model" }));

    expect(insertedValues?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).not.toHaveProperty("apiKeyCiphertext");
    expect(conflictSet).toMatchObject({ model: "org-model" });
  });

  test("does not convert keep plus a typed key into an implicit replacement", async () => {
    await saveOrgSettings(
      null,
      settingsForm({ apiKeyAction: "keep", apiKey: "sk-ignored-secret" }),
    );

    expect(insertedValues?.apiKeyCiphertext).toBeNull();
    expect(conflictSet).not.toHaveProperty("apiKeyCiphertext");
  });

  test("clears the stored key on explicit reset", async () => {
    await saveOrgSettings(null, settingsForm({ apiKeyAction: "remove" }));

    expect(conflictSet?.apiKeyCiphertext).toBeNull();
  });

  test("rejects replace without a new key", async () => {
    const result = await saveOrgSettings(null, settingsForm({ apiKeyAction: "replace" }));

    expect(result).toEqual({
      status: "error",
      message: "Enter a new API key before replacing the stored key.",
    });
    expect(insertCount).toBe(0);
  });

  test("rejects invalid provider API bases before storage", async () => {
    await expect(
      saveOrgSettings(null, settingsForm({ apiBase: "http://127.0.0.1/v1" })),
    ).rejects.toThrow("API base URL must use https:");
    expect(insertCount).toBe(0);
  });
});

describe("SettingsForm API key handling", () => {
  test("renders the key input as write-only password state", () => {
    const source = readFileSync("src/app/orgs/[slug]/settings-form.tsx", "utf8");

    expect(source).toContain('type="password"');
    expect(source).toContain('name="apiKey"');
    expect(source).toContain("Using Postil's hosted inference.");
    expect(source).toContain("Using your own API key.");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("stored key cannot be read back");
    expect(source).not.toContain('type="radio"');
    expect(source).not.toContain("defaultValue={settings?.apiKey");
    expect(source).not.toContain("value={settings?.apiKey");
  });
});
