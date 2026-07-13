import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getSealingKey, seal } from "@/lib/crypto/seal";

let storedRow: Record<string, unknown> | undefined;
let sentInput: Record<string, unknown> | undefined;
let updatedValues: Record<string, unknown> | undefined;

const selectChain = {
  from() { return selectChain; },
  innerJoin() { return selectChain; },
  where() { return selectChain; },
  limit() { return Promise.resolve(storedRow ? [storedRow] : []); },
};
const updateChain = {
  set(values: Record<string, unknown>) { updatedValues = values; return updateChain; },
  where() { return Promise.resolve([]); },
};

mock.module("@/lib/db", () => ({
  getDb: () => ({ select: () => selectChain, update: () => updateChain }),
  schema: {
    organizations: { id: "organizations.id", name: "organizations.name" },
    organizationEntitlements: {
      orgId: "organization_entitlements.org_id",
      billingContactPending: "organization_entitlements.billing_contact_pending",
      billingContactVerificationTokenDigest: "organization_entitlements.billing_contact_verification_token_digest",
      billingContactVerificationTokenCiphertext: "organization_entitlements.billing_contact_verification_token_ciphertext",
      billingContactVerificationExpiresAt: "organization_entitlements.billing_contact_verification_expires_at",
      billingContactVerificationSentAt: "organization_entitlements.billing_contact_verification_sent_at",
      billingContactVerificationMessageId: "organization_entitlements.billing_contact_verification_message_id",
    },
  },
}));

mock.module("@/lib/billing-contact-verification", () => ({
  billingContactVerificationUrl: (_origin: string, orgId: number, token: string) =>
    `https://postil.dev/verify/billing-contact?org=${orgId}&token=${token}`,
  sendBillingContactVerification: async (input: Record<string, unknown>) => {
    sentInput = input;
    return { messageId: "brevo-message-7" };
  },
}));

const { runBillingContactVerificationJob } = await import("@/worker/billing-contact-verification");

describe("durable billing contact verification job", () => {
  beforeEach(() => {
    process.env.POSTIL_SEALING_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.BREVO_API_KEY = "brevo-key";
    sentInput = undefined;
    updatedValues = undefined;
    storedRow = {
      orgName: "Acme",
      pendingEmail: "billing@example.com",
      tokenDigest: Buffer.alloc(32, 7),
      tokenCiphertext: seal("verification-token", getSealingKey()),
      expiresAt: new Date(Date.now() + 60_000),
    };
  });

  test("unseals the durable token, sends, and records provider metadata", async () => {
    const digest = Buffer.alloc(32, 7).toString("base64url");
    await runBillingContactVerificationJob({ orgId: 7, tokenDigest: digest });
    expect(sentInput).toMatchObject({
      recipient: "billing@example.com",
      orgName: "Acme",
      apiKey: "brevo-key",
      idempotencyKey: `billing-contact-verification-${digest}`,
    });
    expect(sentInput?.verificationUrl).toContain("token=verification-token");
    expect(updatedValues?.billingContactVerificationSentAt).toBeInstanceOf(Date);
    expect(updatedValues?.billingContactVerificationMessageId).toBe("brevo-message-7");
  });

  test("silently retires stale jobs without sending", async () => {
    await runBillingContactVerificationJob({
      orgId: 7,
      tokenDigest: Buffer.alloc(32, 8).toString("base64url"),
    });
    expect(sentInput).toBeUndefined();
    expect(updatedValues).toBeUndefined();
  });

  test("rejects malformed payloads before reading storage", async () => {
    await expect(runBillingContactVerificationJob({ orgId: 0, tokenDigest: "bad" })).rejects.toThrow(
      "billing contact verification job payload is malformed",
    );
  });
});
