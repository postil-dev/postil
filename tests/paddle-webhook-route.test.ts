import { beforeEach, describe, expect, mock, test } from "bun:test";

let unmarshalFailure = false;
let applyFailure = false;
let receivedBody = "";
let receivedSignature = "";

mock.module("@/lib/db", () => ({ getDb: () => ({}) }));

mock.module("@/lib/paddle-billing", () => ({
  unmarshalPaddleWebhook: async (body: string, signature: string) => {
    receivedBody = body;
    receivedSignature = signature;
    if (unmarshalFailure) throw new Error("bad signature");
    return { eventId: "evt_test" };
  },
  applyPaddleWebhookEvent: async () => {
    if (applyFailure) throw new Error("database unavailable");
    return { duplicate: false, outcome: "applied" };
  },
}));

const { POST } = await import("@/app/api/webhooks/paddle/route");

describe("Paddle webhook route", () => {
  beforeEach(() => {
    unmarshalFailure = false;
    applyFailure = false;
    receivedBody = "";
    receivedSignature = "";
  });

  test("requires the provider signature", async () => {
    const response = await POST(
      new Request("https://postil.dev/api/webhooks/paddle", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("passes the untouched body to signature verification", async () => {
    const body = '{"event_id":"evt_test", "data": {}}\n';
    const response = await POST(webhookRequest(body));

    expect(response.status).toBe(200);
    expect(receivedBody).toBe(body);
    expect(receivedSignature).toBe("ts=1;h1=test");
    expect(await response.json()).toEqual({ accepted: true, duplicate: false });
  });

  test("does not retry an invalid signature", async () => {
    unmarshalFailure = true;
    const response = await POST(webhookRequest("{}"));
    expect(response.status).toBe(400);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("rejects an oversized body before signature verification", async () => {
    const response = await POST(
      new Request("https://postil.dev/api/webhooks/paddle", {
        method: "POST",
        headers: {
          "paddle-signature": "ts=1;h1=test",
          "content-length": String(1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect(receivedBody).toBe("");
  });

  test("asks Paddle to retry a durable-processing failure", async () => {
    applyFailure = true;
    const response = await POST(webhookRequest("{}"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });
});

function webhookRequest(body: string): Request {
  return new Request("https://postil.dev/api/webhooks/paddle", {
    method: "POST",
    headers: { "paddle-signature": "ts=1;h1=test" },
    body,
  });
}
