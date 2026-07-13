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
      "https://postil.dev/verify/billing-contact?result=processed",
    );
    expect(first.headers.get("location")).not.toContain("valid-token");
    expect(replay.headers.get("location")).toBe(
      "https://postil.dev/verify/billing-contact?result=processed",
    );
    expect(verificationCalls).toBe(2);
  });

  test("token authorization works without ambient browser credentials or origin headers", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const response = await POST(formRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/verify/billing-contact?result=processed",
    );
    expect(verificationCalls).toBe(1);
  });

  test("token authorization accepts an opaque Origin from an incognito email flow", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const response = await POST(formRequest("null"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/verify/billing-contact?result=processed",
    );
    expect(verificationCalls).toBe(1);
  });

  test("malformed submissions fail closed without token verification", async () => {
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    const response = await POST(
      new Request("https://postil.dev/verify/billing-contact", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ org: "not-an-org", token: "valid-token" }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postil.dev/verify/billing-contact?result=processed",
    );
    expect(response.headers.get("location")).not.toContain("valid-token");
    expect(verificationCalls).toBe(0);
  });

  test("renders an outcome-neutral public result without a session", async () => {
    const response = await GET(
      new Request("https://postil.dev/verify/billing-contact?result=processed"),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Verification request processed");
    expect(body).toContain("Open Postil");
    expect(body).not.toContain("verified");
    expect(body).not.toContain("valid-token");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(verificationCalls).toBe(0);
  });

  test("does not trust unsigned result query values", async () => {
    const response = await GET(
      new Request("https://postil.dev/verify/billing-contact?status=success"),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("Billing email verified");
    expect(verificationCalls).toBe(0);
  });
});

function formRequest(origin?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (origin) headers.origin = origin;
  return new Request("https://postil.dev/verify/billing-contact", {
    method: "POST",
    headers,
    body: new URLSearchParams({ org: "7", token: "valid-token" }),
  });
}
