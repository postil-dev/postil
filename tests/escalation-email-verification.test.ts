import { beforeEach, describe, expect, test } from "bun:test";

import {
  createEscalationEmailVerification,
  escalationEmailTokenDigest,
  escalationEmailVerificationUrl,
  normalizeEscalationEmail,
  sendEscalationEmailVerification,
  verifyEscalationEmailToken,
} from "@/lib/escalation-email-verification";
import type { Database } from "@/lib/db";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const TOKEN = "a".repeat(43);

beforeEach(() => {
  process.env.POSTIL_SEALING_KEY =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
});

describe("escalation email verification tokens", () => {
  test("normalizes addresses and binds tokens to organization plus address", () => {
    expect(normalizeEscalationEmail("  Owner+Alerts@Example.COM ")).toBe(
      "owner+alerts@example.com",
    );
    const first = escalationEmailTokenDigest(1, "owner@example.com", TOKEN);
    expect(first.equals(escalationEmailTokenDigest(1, "owner@example.com", TOKEN))).toBe(
      true,
    );
    expect(first.equals(escalationEmailTokenDigest(2, "owner@example.com", TOKEN))).toBe(
      false,
    );
    expect(first.equals(escalationEmailTokenDigest(1, "other@example.com", TOKEN))).toBe(
      false,
    );
  });

  test("creates sealed, expiring token state", () => {
    const state = createEscalationEmailVerification(7, "owner@example.com", NOW);
    expect(state.token).toHaveLength(43);
    expect(state.tokenCiphertext.toString("utf8")).not.toContain(state.token);
    expect(state.expiresAt.toISOString()).toBe("2026-07-13T12:00:00.000Z");
  });

  test("accepts a valid token once, then rejects replay", async () => {
    const row = {
      slug: "acme",
      pendingEmail: "owner@example.com",
      tokenDigest: escalationEmailTokenDigest(7, "owner@example.com", TOKEN),
      expiresAt: new Date("2026-07-13T12:00:00.000Z"),
    };
    let consumed = false;
    const db = verificationDb(() => (consumed ? { ...row, tokenDigest: null } : row), () => {
      consumed = true;
      return [{ orgId: 7 }];
    });
    expect(await verifyEscalationEmailToken(db, 7, TOKEN, NOW)).toEqual({
      verified: true,
      slug: "acme",
    });
    expect(await verifyEscalationEmailToken(db, 7, TOKEN, NOW)).toEqual({
      verified: false,
      slug: "acme",
    });
  });

  test("rejects expiry and a token issued for the previous pending address", async () => {
    let updates = 0;
    const expiredDb = verificationDb(
      () => ({
        slug: "acme",
        pendingEmail: "owner@example.com",
        tokenDigest: escalationEmailTokenDigest(7, "owner@example.com", TOKEN),
        expiresAt: new Date("2026-07-12T11:59:59.000Z"),
      }),
      () => {
        updates += 1;
        return [{ orgId: 7 }];
      },
    );
    expect(await verifyEscalationEmailToken(expiredDb, 7, TOKEN, NOW)).toMatchObject({
      verified: false,
    });

    const changedDb = verificationDb(
      () => ({
        slug: "acme",
        pendingEmail: "replacement@example.com",
        tokenDigest: escalationEmailTokenDigest(7, "owner@example.com", TOKEN),
        expiresAt: new Date("2026-07-13T12:00:00.000Z"),
      }),
      () => {
        updates += 1;
        return [{ orgId: 7 }];
      },
    );
    expect(await verifyEscalationEmailToken(changedDb, 7, TOKEN, NOW)).toMatchObject({
      verified: false,
    });
    expect(updates).toBe(0);
  });
});

describe("verification sender", () => {
  test("sends the minimal Brevo message with the durable verification URL", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const verificationUrl = escalationEmailVerificationUrl(
      "https://postil.dev",
      7,
      TOKEN,
    );
    const result = await sendEscalationEmailVerification({
      recipient: "owner@example.com",
      orgName: "Acme",
      verificationUrl,
      idempotencyKey: "verification-digest",
      apiKey: "brevo-test-key",
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return new Response(JSON.stringify({ messageId: "message-7" }), { status: 201 });
      },
    });
    expect(result).toEqual({ messageId: "message-7" });
    expect(request?.url).toBe("https://api.brevo.com/v3/smtp/email");
    const body = JSON.parse(String(request?.init?.body));
    expect(body.to).toEqual([{ email: "owner@example.com" }]);
    expect(body.subject).toBe("Verify your Postil notification email");
    expect(body.textContent).toContain(verificationUrl);
    expect(body.headers["Idempotency-Key"]).toBe("verification-digest");
  });

  test("does not include provider response text in errors", async () => {
    await expect(
      sendEscalationEmailVerification({
        recipient: "owner@example.com",
        orgName: "Acme",
        verificationUrl: "https://postil.dev/verify",
        idempotencyKey: "verification-digest",
        apiKey: "brevo-test-key",
        fetchImpl: async () =>
          new Response("provider echoed a sensitive payload", { status: 503 }),
      }),
    ).rejects.toThrow("Brevo verification email failed: 503");
  });
});

function verificationDb(
  row: () => Record<string, unknown>,
  updateResult: () => Array<{ orgId: number }>,
): Database {
  const selectChain = {
    from() {
      return selectChain;
    },
    leftJoin() {
      return selectChain;
    },
    where() {
      return selectChain;
    },
    limit() {
      return Promise.resolve([row()]);
    },
  };
  const updateChain = {
    set() {
      return updateChain;
    },
    where() {
      return updateChain;
    },
    returning() {
      return Promise.resolve(updateResult());
    },
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as Database;
}
