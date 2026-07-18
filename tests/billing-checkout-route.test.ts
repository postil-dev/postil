import { beforeEach, describe, expect, mock, test } from "bun:test";

let accessResult: Record<string, unknown>;
let checkoutConfigured = true;
let checkoutCalls = 0;

mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => accessResult,
}));

mock.module("@/lib/oauth", () => ({
  publicOrigin: () => "https://postil.dev",
}));

mock.module("@/lib/paddle-billing", () => ({
  paddleCheckoutConfiguration: () =>
    checkoutConfigured
      ? { clientToken: "test_client", environment: "sandbox" }
      : null,
  createPaddleCheckout: async () => {
    checkoutCalls += 1;
    return {
      clientToken: "test_client",
      environment: "sandbox",
      transactionId: "txn_test",
    };
  },
}));

const { POST } = await import("@/app/api/orgs/[slug]/billing/checkout/route");

describe("billing checkout route", () => {
  beforeEach(() => {
    checkoutConfigured = true;
    checkoutCalls = 0;
    accessResult = {
      ok: true,
      db: {},
      org: { id: 17, slug: "customer" },
      user: { id: 23 },
      membership: { role: "admin" },
    };
  });

  test("rejects cross-origin mutations before membership or provider work", async () => {
    const response = await POST(
      new Request("https://postil.dev/api/orgs/customer/billing/checkout", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      { params: Promise.resolve({ slug: "customer" }) },
    );

    expect(response.status).toBe(403);
    expect(checkoutCalls).toBe(0);
  });

  test("hides checkout from non-admin members", async () => {
    accessResult.membership = { role: "member" };
    const response = await sameOriginPost();

    expect(response.status).toBe(404);
    expect(checkoutCalls).toBe(0);
  });

  test("returns a retryable unavailable response while billing is disabled", async () => {
    checkoutConfigured = false;
    const response = await sameOriginPost();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(checkoutCalls).toBe(0);
  });

  test("returns only the client checkout contract to an organization admin", async () => {
    const response = await sameOriginPost();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      clientToken: "test_client",
      environment: "sandbox",
      transactionId: "txn_test",
    });
    expect(checkoutCalls).toBe(1);
  });
});

function sameOriginPost(): Promise<Response> {
  return POST(
    new Request("https://postil.dev/api/orgs/customer/billing/checkout", {
      method: "POST",
      headers: { origin: "https://postil.dev" },
    }),
    { params: Promise.resolve({ slug: "customer" }) },
  );
}
