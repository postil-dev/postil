import { describe, expect, test } from "bun:test";

import { verifyHostedProvider } from "../scripts/verify-hosted-provider";

describe("hosted provider preflight", () => {
  test("accepts a bounded no-publication model response", async () => {
    let requestBody: Record<string, unknown> | undefined;
    await verifyHostedProvider({
      apiBase: "https://provider.example/v1",
      model: "provider/model",
      apiKey: "test-key",
      providerSlug: "fireworks",
      providerName: "Fireworks",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          model: "provider/model",
          provider: "Fireworks",
          choices: [{ message: { content: "ready" } }],
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
      provider: { only: ["fireworks"], allow_fallbacks: false },
    });
    expect(JSON.stringify(requestBody)).not.toContain("github");
  });

  test("fails closed on provider rejection or malformed output", async () => {
    await expect(
      verifyHostedProvider({
        apiBase: "https://provider.example/v1",
        model: "provider/model",
        apiKey: "test-key",
        providerSlug: "fireworks",
        providerName: "Fireworks",
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("status 503");
    await expect(
      verifyHostedProvider({
        apiBase: "https://provider.example/v1",
        model: "provider/model",
        apiKey: "test-key",
        providerSlug: "fireworks",
        providerName: "Fireworks",
        fetchImpl: async () => Response.json({ choices: [] }),
      }),
    ).rejects.toThrow("no text choice");
  });

  test("rejects mismatched provider, model, usage, or cost identity", async () => {
    const base = {
      apiBase: "https://provider.example/v1",
      model: "provider/model",
      apiKey: "test-key",
      providerSlug: "fireworks",
      providerName: "Fireworks",
    };
    const valid = {
      model: "provider/model",
      provider: "Fireworks",
      choices: [{ message: { content: "ready" } }],
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
    ] as const) {
      await expect(
        verifyHostedProvider({
          ...base,
          fetchImpl: async () => Response.json(payload),
        }),
      ).rejects.toThrow(message);
    }
  });
});
