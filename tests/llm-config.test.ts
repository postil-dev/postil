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

const { REVIEW_DEADLINE_MS, buildCliEnv, resolveLlmConfig, resolveOrgReviewConfig } =
  await import("@/worker/review");

const KEY_NAMES = [
  "MODEL_API_KEY",
  "POSTIL_API_KEY",
  "OPENROUTER_API_KEY",
  "POSTIL_API_BASE",
  "POSTIL_API_FORMAT",
  "POSTIL_ENDPOINT_AUTH_HEADER",
  "POSTIL_ENDPOINT_AUTH_VALUE",
  "REVIEW_MODEL",
  "REVIEW_MODEL_CASCADE",
  "POSTIL_LLM_REQUEST_TIMEOUT_SECS",
  "POSTIL_LLM_TOTAL_TIMEOUT_SECS",
  "POSTIL_PROVISIONAL_HOSTED_ROSTER",
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
        apiFormat: "anthropic",
        apiKeyCiphertext: null,
        apiAuthHeaderCiphertext: Buffer.from("X-Ignored"),
        apiAuthValueCiphertext: Buffer.from("ignored"),
        model: "org-model",
        modelCascade: "org-cascade",
      },
    ];

    await expect(resolveLlmConfig(123)).resolves.toEqual({
      byok: false,
      apiBase: "https://openrouter.ai/api/v1",
      apiFormat: "openai-compatible",
      apiKey: "hosted-default-key",
      apiAuthHeader: undefined,
      apiAuthValue: undefined,
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
        apiFormat: "anthropic",
        apiKeyCiphertext: Buffer.from("org-key"),
        apiAuthHeaderCiphertext: Buffer.from("CF-Access-Client-Secret"),
        apiAuthValueCiphertext: Buffer.from("gateway-key"),
        model: "org-model",
        modelCascade: "org-cascade",
      },
    ];

    await expect(resolveLlmConfig(123)).resolves.toEqual({
      byok: true,
      apiBase: "https://11.0.0.1/v1",
      apiFormat: "anthropic",
      apiKey: "org-key",
      apiAuthHeader: "CF-Access-Client-Secret",
      apiAuthValue: "gateway-key",
      model: "org-model",
      modelCascade: "org-cascade",
    });
  });

  test("treats legacy BYOK rows without an API format as OpenAI-compatible", async () => {
    orgSettingsRows = [
      {
        apiBase: "https://11.0.0.1/v1",
        apiKeyCiphertext: Buffer.from("legacy-key"),
        model: "legacy-model",
        modelCascade: null,
      },
    ];

    await expect(resolveLlmConfig(123)).resolves.toMatchObject({
      byok: true,
      apiFormat: "openai-compatible",
      apiKey: "legacy-key",
      model: "legacy-model",
    });
  });

  test("allows Authorization endpoint auth only for stored Anthropic BYOK", async () => {
    orgSettingsRows = [
      {
        apiBase: "https://11.0.0.1/v1",
        apiFormat: "anthropic",
        apiKeyCiphertext: Buffer.from("provider-key"),
        apiAuthHeaderCiphertext: Buffer.from("Authorization"),
        apiAuthValueCiphertext: Buffer.from("Bearer gateway-key"),
        model: "claude-model",
        modelCascade: null,
      },
    ];
    await expect(resolveLlmConfig(123)).resolves.toMatchObject({
      apiFormat: "anthropic",
      apiAuthHeader: "Authorization",
    });

    orgSettingsRows = [{ ...(orgSettingsRows[0] as object), apiFormat: "openai-compatible" }];
    await expect(resolveLlmConfig(123)).rejects.toThrow(
      "conflicts with a provider or transport header",
    );
  });
});

describe("buildCliEnv", () => {
  test("passes both preferred and legacy API key names to pinned CLI processes", () => {
    const env = buildCliEnv(
      {
        byok: true,
        apiBase: "https://openrouter.ai/api/v1",
        apiFormat: "anthropic",
        apiKey: "model-key",
        apiAuthHeader: "CF-Access-Client-Secret",
        apiAuthValue: "gateway-key",
        model: "deepseek/deepseek-v4-pro",
        modelCascade: "qwen/qwen3-coder",
      },
      { GITHUB_TOKEN: "github-token" },
    );

    expect(env).toMatchObject({
      GITHUB_TOKEN: "github-token",
      POSTIL_PREVENTION_HINT: "0",
      POSTIL_PREVENTION_COMMANDS_JSON: "[]",
      POSTIL_API_BASE: "https://openrouter.ai/api/v1",
      POSTIL_API_FORMAT: "anthropic",
      POSTIL_HOSTED_MODE: "0",
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "0",
      POSTIL_ENDPOINT_AUTH_HEADER: "CF-Access-Client-Secret",
      POSTIL_ENDPOINT_AUTH_VALUE: "gateway-key",
      POSTIL_LLM_REQUEST_TIMEOUT_SECS: "420",
      POSTIL_LLM_TOTAL_TIMEOUT_SECS: "540",
      MODEL_API_KEY: "model-key",
      POSTIL_API_KEY: "model-key",
      OPENROUTER_API_KEY: "",
      LLM_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      REVIEW_MODEL: "deepseek/deepseek-v4-pro",
      REVIEW_MODEL_CASCADE: "qwen/qwen3-coder",
    });
    expect(
      Number(env.POSTIL_LLM_TOTAL_TIMEOUT_SECS) -
        Number(env.POSTIL_LLM_REQUEST_TIMEOUT_SECS),
    ).toBe(120);
    expect(Number(env.POSTIL_LLM_TOTAL_TIMEOUT_SECS) * 1000).toBeLessThan(
      REVIEW_DEADLINE_MS,
    );
  });

  test("shadows every hosted credential alias in BYOK child environments", () => {
    const env = buildCliEnv({
      byok: true,
      apiBase: "https://provider.example/v1",
      apiFormat: "openai-compatible",
      apiKey: "customer-key",
      apiAuthHeader: undefined,
      apiAuthValue: undefined,
      model: "customer/model",
      modelCascade: undefined,
    });

    expect(env).toMatchObject({
      MODEL_API_KEY: "customer-key",
      POSTIL_API_KEY: "customer-key",
      OPENROUTER_API_KEY: "",
      LLM_API_KEY: "",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
  });

  test("lets operators override hosted CLI LLM timeout budgets", () => {
    process.env.POSTIL_LLM_REQUEST_TIMEOUT_SECS = "90";
    process.env.POSTIL_LLM_TOTAL_TIMEOUT_SECS = "360";
    process.env.POSTIL_PROVISIONAL_HOSTED_ROSTER = "1";

    const env = buildCliEnv(
      {
        byok: false,
        apiBase: "https://openrouter.ai/api/v1",
        apiFormat: "openai-compatible",
        apiKey: undefined,
        apiAuthHeader: undefined,
        apiAuthValue: undefined,
        model: undefined,
        modelCascade: undefined,
      },
      {},
    );

    expect(env).toMatchObject({
      POSTIL_LLM_REQUEST_TIMEOUT_SECS: "90",
      POSTIL_LLM_TOTAL_TIMEOUT_SECS: "360",
      POSTIL_HOSTED_MODE: "1",
      POSTIL_PROVISIONAL_HOSTED_ROSTER: "1",
      POSTIL_ENDPOINT_AUTH_HEADER: "",
      POSTIL_ENDPOINT_AUTH_VALUE: "",
      POSTIL_PREVENTION_HINT: "0",
      POSTIL_PREVENTION_COMMANDS_JSON: "[]",
    });
  });

  test("normalizes the per-review prevention hint instead of inheriting deployment state", () => {
    const llm = {
      byok: false,
      apiBase: "https://openrouter.ai/api/v1",
      apiFormat: "openai-compatible" as const,
      apiKey: undefined,
      apiAuthHeader: undefined,
      apiAuthValue: undefined,
      model: undefined,
      modelCascade: undefined,
    };

    expect(buildCliEnv(llm).POSTIL_PREVENTION_HINT).toBe("0");
    expect(buildCliEnv(llm, { POSTIL_PREVENTION_HINT: "1" }).POSTIL_PREVENTION_HINT).toBe("1");
    expect(buildCliEnv(llm, { POSTIL_PREVENTION_HINT: "true" }).POSTIL_PREVENTION_HINT).toBe("0");
    expect(buildCliEnv(llm).POSTIL_PREVENTION_COMMANDS_JSON).toBe("[]");
    expect(
      buildCliEnv(llm, { POSTIL_PREVENTION_COMMANDS_JSON: '["bun run test"]' })
        .POSTIL_PREVENTION_COMMANDS_JSON,
    ).toBe('["bun run test"]');
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

  test("removes model selection from legacy organization fallback config", async () => {
    orgSettingsRows = [
      {
        configYaml: "review:\n  minConfidence: 0.8\nmodel:\n  name: stale-model\n",
        guardrailsMd: null,
        contentPolicyMd: null,
      },
    ];

    await expect(resolveOrgReviewConfig(123)).resolves.toEqual({
      configYaml: "review:\n  minConfidence: 0.8\n",
      guardrailsMd: null,
      contentPolicyMd: null,
    });
  });

  test("returns null without an organization or settings row", async () => {
    await expect(resolveOrgReviewConfig(null)).resolves.toBeNull();
    await expect(resolveOrgReviewConfig(123)).resolves.toBeNull();
  });
});
