import { afterEach, describe, expect, mock, test } from "bun:test";

const ORIGINAL_PUBLIC_URL = process.env.POSTIL_PUBLIC_URL;
let verificationCalls = 0;
let consumed = false;

mock.module("@/lib/db", () => ({ getDb: () => ({}) }));
mock.module("@/lib/billing-contact-verification", () => ({
  verifyBillingContactToken: async (_db: unknown, orgId: number, token: string) => {
    verificationCalls += 1;
    if (orgId !== 7 || token !== "valid-token" || consumed) {
      return { verified: false, slug: "acme" };
    }
    consumed = true;
    return { verified: true, slug: "acme" };
  },
}));

const { GET, POST } = await import("@/app/verify/billing-contact/route");

afterEach(() => {
  verificationCalls = 0;
  consumed = false;
  if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.POSTIL_PUBLIC_URL;
  else process.env.POSTIL_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
});

describe("billing contact verification route", () => {
  test("GET renders confirmation without consuming the token", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const response = await GET(
      new Request("https://postil.dev/verify/billing-contact?org=7&token=valid-token"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Confirm billing email");
    expect(verificationCalls).toBe(0);
  });

  test("same-origin POST consumes a token once", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const first = await POST(formRequest("https://postil.dev"));
    const replay = await POST(formRequest("https://postil.dev"));

    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(
      "https://postil.dev/orgs/acme/billing?contactVerification=success",
    );
    expect(replay.headers.get("location")).toBe(
      "https://postil.dev/orgs/acme/billing?contactVerification=invalid",
    );
    expect(verificationCalls).toBe(2);
  });

  test("rejects cross-origin POST before token verification", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const response = await POST(formRequest("https://evil.test"));
    expect(response.status).toBe(403);
    expect(verificationCalls).toBe(0);
  });
});

function formRequest(origin: string): Request {
  return new Request("https://postil.dev/verify/billing-contact", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ org: "7", token: "valid-token" }),
  });
}
