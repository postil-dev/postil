import { describe, expect, test } from "bun:test";

import {
  hostedProviderApiKeyFromEnv,
  verifyHostedProvider,
} from "../scripts/verify-hosted-provider";

describe("hosted provider preflight", () => {
  test("uses the review worker's provider credential precedence", () => {
    const previous = {
      MODEL_API_KEY: process.env.MODEL_API_KEY,
      POSTIL_API_KEY: process.env.POSTIL_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    try {
      delete process.env.MODEL_API_KEY;
      delete process.env.POSTIL_API_KEY;
      process.env.OPENROUTER_API_KEY = "openrouter-key";
      expect(hostedProviderApiKeyFromEnv()).toBe("openrouter-key");

      process.env.POSTIL_API_KEY = "postil-key";
      expect(hostedProviderApiKeyFromEnv()).toBe("postil-key");

      process.env.MODEL_API_KEY = "model-key";
      expect(hostedProviderApiKeyFromEnv()).toBe("model-key");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("accepts a bounded no-publication model response", async () => {
    let requestBody: Record<string, unknown> | undefined;
    await verifyHostedProvider({
      apiBase: "https://provider.example/v1",
      model: "provider/model",
      apiKey: "test-key",
      providerName: "Fireworks",
      maxPromptPrice: 1.4,
      maxCompletionPrice: 4.4,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          model: "provider/model",
          provider: "Fireworks",
          choices: [{ finish_reason: "stop", message: { content: "ready" } }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 1,
            total_tokens: 9,
            cost: 0.00001,
            cost_details: { upstream_inference_cost: 0.000009 },
          },
        });
      },
    });
    expect(requestBody).toMatchObject({
      model: "provider/model",
      max_tokens: 128,
      temperature: 0,
      provider: {
        data_collection: "deny",
        zdr: true,
        order: ["Fireworks"],
        allow_fallbacks: false,
        max_price: { prompt: 1.4, completion: 4.4 },
      },
    });
    expect(JSON.stringify(requestBody)).not.toContain("github");
  });

  test("fails closed on provider rejection or malformed output", async () => {
    await expect(
      verifyHostedProvider({
        apiBase: "https://provider.example/v1",
        model: "provider/model",
        apiKey: "test-key",
        providerName: "Fireworks",
        maxPromptPrice: 1.4,
        maxCompletionPrice: 4.4,
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("status 503");
    await expect(
      verifyHostedProvider({
        apiBase: "https://provider.example/v1",
        model: "provider/model",
        apiKey: "test-key",
        providerName: "Fireworks",
        maxPromptPrice: 1.4,
        maxCompletionPrice: 4.4,
        fetchImpl: async () => Response.json({ choices: [] }),
      }),
    ).rejects.toThrow("no text choice");
  });

  test("rejects mismatched provider, model, usage, or cost identity", async () => {
    const base = {
      apiBase: "https://provider.example/v1",
      model: "provider/model",
      apiKey: "test-key",
      providerName: "Fireworks",
      maxPromptPrice: 1.4,
      maxCompletionPrice: 4.4,
    };
    const valid = {
      model: "provider/model",
      provider: "Fireworks",
      choices: [{ finish_reason: "stop", message: { content: "ready" } }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 1,
        total_tokens: 9,
        cost: 0.00001,
        cost_details: { upstream_inference_cost: 0.000009 },
      },
    };
    for (const [payload, message] of [
      [{ ...valid, provider: "DeepInfra" }, "unexpected provider"],
      [{ ...valid, model: "provider/other" }, "unexpected model"],
      [{ ...valid, usage: { ...valid.usage, total_tokens: 8 } }, "invalid token usage"],
      [{ ...valid, usage: { ...valid.usage, cost: null } }, "invalid cost accounting"],
      [{
        ...valid,
        usage: {
          ...valid.usage,
          cost: 0.1,
          cost_details: { upstream_inference_cost: 0.1 },
        },
      }, "price ceiling"],
    ] as const) {
      await expect(
        verifyHostedProvider({
          ...base,
          fetchImpl: async () => Response.json(payload),
        }),
      ).rejects.toThrow(message);
    }
  });

  test("rejects empty, refused, or truncated responses", async () => {
    const base = {
      apiBase: "https://provider.example/v1",
      model: "provider/model",
      apiKey: "test-key",
      providerName: "Fireworks",
      maxPromptPrice: 1.4,
      maxCompletionPrice: 4.4,
    };
    const usage = {
      prompt_tokens: 8,
      completion_tokens: 1,
      total_tokens: 9,
      cost: 0.00001,
      cost_details: { upstream_inference_cost: 0.000009 },
    };
    for (const choice of [
      { finish_reason: "stop", message: { content: "" } },
      { finish_reason: "stop", message: { content: "ready", refusal: "cannot comply" } },
      { finish_reason: "length", message: { content: "ready" } },
      { finish_reason: "stop", message: { content: "read" } },
    ]) {
      await expect(
        verifyHostedProvider({
          ...base,
          fetchImpl: async () => Response.json({
            model: "provider/model",
            provider: "Fireworks",
            choices: [choice],
            usage,
          }),
        }),
      ).rejects.toThrow("unusable text choice");
    }
  });
});
