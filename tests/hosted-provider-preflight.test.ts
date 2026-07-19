import { describe, expect, test } from "bun:test";

import { verifyHostedProvider } from "../scripts/verify-hosted-provider";

describe("hosted provider preflight", () => {
  test("accepts a bounded no-publication model response", async () => {
    let requestBody: Record<string, unknown> | undefined;
    await verifyHostedProvider({
      apiBase: "https://provider.example/v1",
      model: "provider/model",
      apiKey: "test-key",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "ready" } }] });
      },
    });
    expect(requestBody).toMatchObject({
      model: "provider/model",
      max_tokens: 8,
      temperature: 0,
    });
    expect(JSON.stringify(requestBody)).not.toContain("github");
  });

  test("fails closed on provider rejection or malformed output", async () => {
    await expect(
      verifyHostedProvider({
        apiBase: "https://provider.example/v1",
        model: "provider/model",
        apiKey: "test-key",
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("status 503");
    await expect(
      verifyHostedProvider({
        apiBase: "https://provider.example/v1",
        model: "provider/model",
        apiKey: "test-key",
        fetchImpl: async () => Response.json({ choices: [] }),
      }),
    ).rejects.toThrow("no text choice");
  });
});
