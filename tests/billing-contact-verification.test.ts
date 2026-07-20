import { beforeEach, describe, expect, test } from "bun:test";

import {
  billingContactTokenDigest,
  billingContactVerificationUrl,
  createBillingContactVerification,
  normalizeBillingContact,
  sendBillingContactVerification,
  verifyBillingContactToken,
} from "@/lib/billing-contact-verification";
import type { Database } from "@/lib/db";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const TOKEN = "a".repeat(43);

beforeEach(() => {
  process.env.POSTIL_SEALING_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
});

describe("billing contact verification tokens", () => {
  test("normalizes addresses and binds tokens to the organization, purpose, and address", () => {
    expect(normalizeBillingContact("  Accounts+Payable@Example.COM ")).toBe(
      "accounts+payable@example.com",
    );
    const first = billingContactTokenDigest(1, "billing@example.com", TOKEN);
    expect(first.equals(billingContactTokenDigest(1, "billing@example.com", TOKEN))).toBe(true);
    expect(first.equals(billingContactTokenDigest(2, "billing@example.com", TOKEN))).toBe(false);
    expect(first.equals(billingContactTokenDigest(1, "other@example.com", TOKEN))).toBe(false);
  });

  test("creates sealed, expiring token state and a bounded verification URL", () => {
    const state = createBillingContactVerification(7, "billing@example.com", NOW);
    expect(state.token).toHaveLength(43);
    expect(state.tokenCiphertext.toString("utf8")).not.toContain(state.token);
    expect(state.expiresAt.toISOString()).toBe("2026-07-13T12:00:00.000Z");
    expect(billingContactVerificationUrl("https://postil.dev", 7, TOKEN)).toBe(
      `https://postil.dev/verify/billing-contact?org=7&token=${TOKEN}`,
    );
  });

  test("activates a valid pending address once, then rejects replay", async () => {
    const row = {
      slug: "acme",
      pendingEmail: "billing@example.com",
      tokenDigest: billingContactTokenDigest(7, "billing@example.com", TOKEN),
      expiresAt: new Date("2026-07-13T12:00:00.000Z"),
    };
    let consumed = false;
    let values: Record<string, unknown> | undefined;
    const db = verificationDb(
      () => (consumed ? { ...row, tokenDigest: null } : row),
      (update) => {
        values = update;
        consumed = true;
        return [{ orgId: 7 }];
      },
    );
    expect(await verifyBillingContactToken(db, 7, TOKEN, NOW)).toEqual({
      verified: true,
      slug: "acme",
    });
    expect(values).toMatchObject({
      billingContactEmail: "billing@example.com",
      billingContactPending: null,
      billingContactVerifiedAt: NOW,
      billingContactVerificationTokenDigest: null,
    });
    expect(await verifyBillingContactToken(db, 7, TOKEN, NOW)).toEqual({
      verified: false,
      slug: "acme",
    });
  });

  test("rejects expiry, malformed tokens, and tokens issued for another pending address", async () => {
    let updates = 0;
    for (const [pendingEmail, expiresAt, token] of [
      ["billing@example.com", new Date("2026-07-12T11:59:59.000Z"), TOKEN],
      ["billing@example.com", new Date("2026-07-13T12:00:00.000Z"), "short"],
      ["replacement@example.com", new Date("2026-07-13T12:00:00.000Z"), TOKEN],
    ] as const) {
      const db = verificationDb(
        () => ({
          slug: "acme",
          pendingEmail,
          tokenDigest: billingContactTokenDigest(7, "billing@example.com", TOKEN),
          expiresAt,
        }),
        () => {
          updates += 1;
          return [{ orgId: 7 }];
        },
      );
      expect(await verifyBillingContactToken(db, 7, token, NOW)).toMatchObject({ verified: false });
    }
    expect(updates).toBe(0);
  });
});

describe("billing verification sender", () => {
  test("sends minimal billing copy with provider idempotency", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const result = await sendBillingContactVerification({
      recipient: "billing@example.com",
      orgName: "Acme\nInjected",
      verificationUrl: "https://postil.dev/verify/billing-contact?org=7&token=secret",
      idempotencyKey: "verification-digest",
      apiKey: "brevo-test-key",
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return new Response(JSON.stringify({ messageId: "message-7" }), { status: 201 });
      },
    });
    expect(result).toEqual({ messageId: "message-7" });
    const body = JSON.parse(String(request?.init?.body));
    expect(body.subject).toBe("Verify your Postil billing contact");
    expect(body.textContent).toContain("billing contact for Acme Injected");
    expect(body.htmlContent).toContain("Verify billing contact email");
    expect(body.headers["Idempotency-Key"]).toBe("verification-digest");
  });
});

function verificationDb(
  row: () => Record<string, unknown>,
  updateResult: (values: Record<string, unknown>) => Array<{ orgId: number }>,
): Database {
  const selectChain = {
    from() { return selectChain; },
    leftJoin() { return selectChain; },
    where() { return selectChain; },
    limit() { return Promise.resolve([row()]); },
  };
  let values: Record<string, unknown> = {};
  const updateChain = {
    set(next: Record<string, unknown>) { values = next; return updateChain; },
    where() { return updateChain; },
    returning() { return Promise.resolve(updateResult(values)); },
  };
  return { select: () => selectChain, update: () => updateChain } as unknown as Database;
}
