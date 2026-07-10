import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const schema = {
  orgSettings: {
    orgId: "org_id",
    configYaml: "config_yaml",
    guardrailsMd: "guardrails_md",
    contentPolicyMd: "content_policy_md",
  },
};
let orgSettingsRows: unknown[] = [];

function fakeDb() {
  const chain = {
    select() {
      return chain;
    },
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      return Promise.resolve(orgSettingsRows);
    },
  };
  return chain;
}

mock.module("@/lib/db", () => ({
  getDb: () => fakeDb(),
  getPool: () => {
    throw new Error("getPool is not mocked for llm-config tests");
  },
  closeDb: async () => undefined,
  schema,
}));

mock.module("@/lib/crypto/seal", () => ({
  getSealingKey: () => Buffer.alloc(32),
  unseal: (sealed: Buffer) => sealed.toString("utf8"),
}));

const { buildCliEnv, resolveLlmConfig, resolveOrgReviewConfig } = await import(
  "@/worker/review"
);

const KEY_NAMES = [
  "MODEL_API_KEY",
  "POSTIL_API_KEY",
  "OPENROUTER_API_KEY",
  "POSTIL_API_BASE",
  "REVIEW_MODEL",
  "REVIEW_MODEL_CASCADE",
] as const;

const originalValues = new Map(
  KEY_NAMES.map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const key of KEY_NAMES) {
    const original = originalValues.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

function clearEnv(): void {
  for (const key of KEY_NAMES) {
    delete process.env[key];
  }
}

beforeEach(() => {
  clearEnv();
  orgSettingsRows = [];
});

afterEach(() => {
  restoreEnv();
  orgSettingsRows = [];
});

describe("resolveLlmConfig", () => {
  test("prefers MODEL_API_KEY over legacy aliases", async () => {
    process.env.MODEL_API_KEY = "model-key";
    process.env.POSTIL_API_KEY = "postil-key";
    process.env.OPENROUTER_API_KEY = "openrouter-key";

    const config = await resolveLlmConfig(null);

    expect(config.apiKey).toBe("model-key");
  });

  test("falls back to POSTIL_API_KEY, then OPENROUTER_API_KEY", async () => {
    delete process.env.MODEL_API_KEY;
    process.env.POSTIL_API_KEY = "postil-key";
    process.env.OPENROUTER_API_KEY = "openrouter-key";

    await expect(resolveLlmConfig(null)).resolves.toMatchObject({
      apiKey: "postil-key",
    });

    delete process.env.POSTIL_API_KEY;

    await expect(resolveLlmConfig(null)).resolves.toMatchObject({
      apiKey: "openrouter-key",
    });
  });

  test("ignores org provider overrides when the org has no stored key", async () => {
    process.env.MODEL_API_KEY = "hosted-default-key";
    process.env.REVIEW_MODEL = "hosted-default-model";
    process.env.REVIEW_MODEL_CASCADE = "hosted-default-cascade";
    orgSettingsRows = [
      {
        apiBase: "https://11.0.0.1/v1",
        apiKeyCiphertext: null,
        model: "org-model",
        modelCascade: "org-cascade",
      },
    ];

    await expect(resolveLlmConfig(123)).resolves.toEqual({
      apiBase: "https://openrouter.ai/api/v1",
      apiKey: "hosted-default-key",
      model: "hosted-default-model",
      modelCascade: "hosted-default-cascade",
    });
  });

  test("uses org provider overrides atomically with the org stored key", async () => {
    process.env.MODEL_API_KEY = "hosted-default-key";
    process.env.REVIEW_MODEL = "hosted-default-model";
    orgSettingsRows = [
      {
        apiBase: "https://11.0.0.1/v1",
        apiKeyCiphertext: Buffer.from("org-key"),
        model: "org-model",
        modelCascade: "org-cascade",
      },
    ];

    await expect(resolveLlmConfig(123)).resolves.toEqual({
      apiBase: "https://11.0.0.1/v1",
      apiKey: "org-key",
      model: "org-model",
      modelCascade: "org-cascade",
    });
  });
});

describe("buildCliEnv", () => {
  test("passes both preferred and legacy API key names to pinned CLI processes", () => {
    const env = buildCliEnv(
      {
        apiBase: "https://openrouter.ai/api/v1",
        apiKey: "model-key",
        model: "deepseek/deepseek-v4-pro",
        modelCascade: "qwen/qwen3-coder",
      },
      { GITHUB_TOKEN: "github-token" },
    );

    expect(env).toMatchObject({
      GITHUB_TOKEN: "github-token",
      POSTIL_API_BASE: "https://openrouter.ai/api/v1",
      MODEL_API_KEY: "model-key",
      POSTIL_API_KEY: "model-key",
      REVIEW_MODEL: "deepseek/deepseek-v4-pro",
      REVIEW_MODEL_CASCADE: "qwen/qwen3-coder",
    });
  });
});

describe("resolveOrgReviewConfig", () => {
  test("loads hosted review config even when the org has no BYO API key", async () => {
    orgSettingsRows = [
      {
        configYaml: "enabled: true\n",
        guardrailsMd: "Guardrail.\n",
        contentPolicyMd: null,
      },
    ];

    await expect(resolveOrgReviewConfig(123)).resolves.toEqual({
      configYaml: "enabled: true\n",
      guardrailsMd: "Guardrail.\n",
      contentPolicyMd: null,
    });
  });

  test("returns null without an organization or settings row", async () => {
    await expect(resolveOrgReviewConfig(null)).resolves.toBeNull();
    await expect(resolveOrgReviewConfig(123)).resolves.toBeNull();
  });
});
