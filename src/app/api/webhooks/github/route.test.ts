import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { GITHUB_WEBHOOK_SECRET: "test-secret" },
}));

// Import after mock so the route uses the stubbed secret.
const { POST } = await import("./route");

vi.mock("@/db", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => undefined }),
    query: { reviews: { findFirst: async () => undefined } },
  }),
  schema: { webhookDeliveries: {}, reviews: {} },
}));

vi.mock("@/lib/posthog", () => ({
  captureException: vi.fn(),
  track: vi.fn(),
}));

function sign(secret: string, body: string): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(body);
  return `sha256=${h.digest("hex")}`;
}

describe("github webhook", () => {
  it("rejects missing signature", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await POST(
      new Request("http://x/webhook", {
        method: "POST",
        body,
        headers: { "x-github-delivery": "a", "x-github-event": "ping" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid signed ping", async () => {
    const body = JSON.stringify({ zen: "hi" });
    const res = await POST(
      new Request("http://x/webhook", {
        method: "POST",
        body,
        headers: {
          "x-github-delivery": "b",
          "x-github-event": "ping",
          "x-hub-signature-256": sign("test-secret", body),
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});
