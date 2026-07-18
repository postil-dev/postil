import { beforeEach, describe, expect, mock, test } from "bun:test";

let accessResult: Record<string, unknown>;
let configured = true;
let portalCalls = 0;

mock.module("@/lib/org-access", () => ({
  getOrgMembership: async () => accessResult,
}));

mock.module("@/lib/oauth", () => ({
  publicOrigin: () => "https://postil.dev",
}));

mock.module("@/lib/paddle-billing", () => ({
  paddleCheckoutConfiguration: () =>
    configured ? { clientToken: "test_client", environment: "sandbox" } : null,
  createPaddlePortalSession: async () => {
    portalCalls += 1;
    return "https://customer-portal.paddle.com/session/test";
  },
}));

const { POST } = await import("@/app/api/orgs/[slug]/billing/portal/route");

describe("billing portal route", () => {
  beforeEach(() => {
    configured = true;
    portalCalls = 0;
    accessResult = {
      ok: true,
      db: {},
      org: { id: 17, slug: "customer" },
      user: { id: 23 },
      membership: { role: "admin" },
    };
  });

  test("requires a same-origin organization admin", async () => {
    const crossOrigin = await request("https://attacker.example");
    expect(crossOrigin.status).toBe(403);
    expect(portalCalls).toBe(0);

    accessResult.membership = { role: "member" };
    const member = await request("https://postil.dev");
    expect(member.status).toBe(404);
    expect(portalCalls).toBe(0);
  });

  test("returns a short-lived provider portal URL without caching", async () => {
    const response = await request("https://postil.dev");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      url: "https://customer-portal.paddle.com/session/test",
    });
    expect(portalCalls).toBe(1);
  });

  test("stays unavailable while Paddle billing is disabled", async () => {
    configured = false;
    const response = await request("https://postil.dev");
    expect(response.status).toBe(503);
    expect(portalCalls).toBe(0);
  });
});

function request(origin: string): Promise<Response> {
  return POST(
    new Request("https://postil.dev/api/orgs/customer/billing/portal", {
      method: "POST",
      headers: { origin },
    }),
    { params: Promise.resolve({ slug: "customer" }) },
  );
}
