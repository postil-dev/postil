import { describe, expect, test } from "bun:test";

import {
  hostedProviderApiKeyFromEnv,
  verifyHostedProvider,
} from "../scripts/verify-hosted-provider";

const base = {
  apiBase: "https://provider.example/v1",
  model: "provider/model",
  apiKey: "test-key",
  providerName: "Fireworks",
  maxPromptPrice: 1.4,
  maxCompletionPrice: 4.4,
};

const validResponse = {
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

  test("retries one rate limit and accepts a valid response", async () => {
    for (const retryAfter of [undefined, "not-a-date", "1.5"]) {
      let requests = 0;
      const delays: number[] = [];
      await verifyHostedProvider({
        ...base,
        fetchImpl: async () => {
          requests += 1;
          return requests === 1
            ? new Response("rate limited", {
              status: 429,
              headers: retryAfter === undefined ? undefined : { "retry-after": retryAfter },
            })
            : Response.json(validResponse);
        },
        sleepImpl: async (milliseconds) => {
          delays.push(milliseconds);
        },
      });
      expect(requests).toBe(2);
      expect(delays).toEqual([500]);
    }
  });

  test("stops after three rate-limit responses", async () => {
    let requests = 0;
    const delays: number[] = [];
    await expect(
      verifyHostedProvider({
        ...base,
        fetchImpl: async () => {
          requests += 1;
          return new Response("rate limited", { status: 429 });
        },
        sleepImpl: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    ).rejects.toThrow("status 429");
    expect(requests).toBe(3);
    expect(delays).toEqual([500, 1_000]);
  });

  test("does not retry non-rate-limit failures", async () => {
    let requests = 0;
    await expect(
      verifyHostedProvider({
        ...base,
        fetchImpl: async () => {
          requests += 1;
          return new Response("unavailable", { status: 503 });
        },
        sleepImpl: async () => {
          throw new Error("unexpected sleep");
        },
      }),
    ).rejects.toThrow("status 503");
    expect(requests).toBe(1);

    let networkRequests = 0;
    await expect(
      verifyHostedProvider({
        ...base,
        fetchImpl: async () => {
          networkRequests += 1;
          throw new Error("network unavailable");
        },
        sleepImpl: async () => {
          throw new Error("unexpected sleep");
        },
      }),
    ).rejects.toThrow("network unavailable");
    expect(networkRequests).toBe(1);
  });

  test("honors bounded numeric and HTTP-date retry delays", async () => {
    for (const [retryAfter, expectedDelay] of [
      ["2", 2_000],
      ["Tue, 25 Aug 2026 12:00:03 GMT", 3_000],
    ] as const) {
      let requests = 0;
      const delays: number[] = [];
      await verifyHostedProvider({
        ...base,
        fetchImpl: async () => {
          requests += 1;
          return requests === 1
            ? new Response("rate limited", {
              status: 429,
              headers: { "retry-after": retryAfter },
            })
            : Response.json(validResponse);
        },
        sleepImpl: async (milliseconds) => {
          delays.push(milliseconds);
        },
        nowMs: () => Date.parse("Tue, 25 Aug 2026 12:00:00 GMT"),
      });
      expect(requests).toBe(2);
      expect(delays).toEqual([expectedDelay]);
    }
  });

  test("fails rather than retrying before an excessive Retry-After", async () => {
    for (const retryAfter of [
      "11",
      "Tue, 25 Aug 2026 12:00:11 GMT",
    ]) {
      let requests = 0;
      await expect(
        verifyHostedProvider({
          ...base,
          fetchImpl: async () => {
            requests += 1;
            return new Response("rate limited", {
              status: 429,
              headers: { "retry-after": retryAfter },
            });
          },
          sleepImpl: async () => {
            throw new Error("unexpected sleep");
          },
          nowMs: () => Date.parse("Tue, 25 Aug 2026 12:00:00 GMT"),
        }),
      ).rejects.toThrow("status 429");
      expect(requests).toBe(1);
    }
  });

  test("enforces the retry window across attempts", async () => {
    let requests = 0;
    let currentTimeMs = Date.parse("Tue, 25 Aug 2026 12:00:00 GMT");
    const delays: number[] = [];
    await expect(
      verifyHostedProvider({
        ...base,
        fetchImpl: async () => {
          requests += 1;
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "6" },
          });
        },
        sleepImpl: async (milliseconds) => {
          delays.push(milliseconds);
          currentTimeMs += milliseconds;
        },
        nowMs: () => currentTimeMs,
      }),
    ).rejects.toThrow("status 429");
    expect(requests).toBe(2);
    expect(delays).toEqual([6_000]);
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
