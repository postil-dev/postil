import { beforeEach, describe, expect, mock, test } from "bun:test";

import { getSealingKey, seal } from "@/lib/crypto/seal";

let storedRow: Record<string, unknown> | undefined;
let sentInput: Record<string, unknown> | undefined;
let updatedValues: Record<string, unknown> | undefined;

const selectChain = {
  from() {
    return selectChain;
  },
  innerJoin() {
    return selectChain;
  },
  where() {
    return selectChain;
  },
  limit() {
    return Promise.resolve(storedRow ? [storedRow] : []);
  },
};
const updateChain = {
  set(values: Record<string, unknown>) {
    updatedValues = values;
    return updateChain;
  },
  where() {
    return Promise.resolve([]);
  },
};

mock.module("@/lib/db", () => ({
  getDb: () => ({ select: () => selectChain, update: () => updateChain }),
  schema: {
    organizations: { id: "organizations.id", name: "organizations.name" },
    orgSettings: {
      orgId: "org_settings.org_id",
      escalationEmailPending: "org_settings.escalation_email_pending",
      escalationEmailVerificationTokenDigest:
        "org_settings.escalation_email_verification_token_digest",
      escalationEmailVerificationTokenCiphertext:
        "org_settings.escalation_email_verification_token_ciphertext",
      escalationEmailVerificationExpiresAt:
        "org_settings.escalation_email_verification_expires_at",
      escalationEmailVerificationSentAt:
        "org_settings.escalation_email_verification_sent_at",
      escalationEmailVerificationMessageId:
        "org_settings.escalation_email_verification_message_id",
    },
  },
}));

mock.module("@/lib/escalation-email-verification", () => ({
  escalationEmailVerificationUrl: (_origin: string, orgId: number, token: string) =>
    `https://postil.dev/verify?org=${orgId}&token=${token}`,
  sendEscalationEmailVerification: async (input: Record<string, unknown>) => {
    sentInput = input;
    return { messageId: "brevo-message-7" };
  },
}));

const { runEscalationEmailVerificationJob } = await import(
  "@/worker/escalation-email-verification"
);

describe("durable escalation email verification job", () => {
  beforeEach(() => {
    process.env.POSTIL_SEALING_KEY =
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    process.env.POSTIL_PUBLIC_URL = "https://postil.dev";
    process.env.BREVO_API_KEY = "brevo-key";
    sentInput = undefined;
    updatedValues = undefined;
    const digest = Buffer.alloc(32, 7);
    storedRow = {
      orgName: "Acme",
      pendingEmail: "owner@example.com",
      tokenDigest: digest,
      tokenCiphertext: seal("verification-token", getSealingKey()),
      expiresAt: new Date(Date.now() + 60_000),
    };
  });

  test("unseals the durable token, sends, and records provider metadata", async () => {
    const digest = Buffer.alloc(32, 7).toString("base64url");
    await runEscalationEmailVerificationJob({ orgId: 7, tokenDigest: digest });
    expect(sentInput).toMatchObject({
      recipient: "owner@example.com",
      orgName: "Acme",
      apiKey: "brevo-key",
      idempotencyKey: `escalation-email-verification-${digest}`,
    });
    expect(sentInput?.verificationUrl).toContain("token=verification-token");
    expect(updatedValues?.escalationEmailVerificationSentAt).toBeInstanceOf(Date);
    expect(updatedValues?.escalationEmailVerificationMessageId).toBe(
      "brevo-message-7",
    );
  });

  test("silently retires stale jobs without sending", async () => {
    await runEscalationEmailVerificationJob({
      orgId: 7,
      tokenDigest: Buffer.alloc(32, 8).toString("base64url"),
    });
    expect(sentInput).toBeUndefined();
    expect(updatedValues).toBeUndefined();
  });
});
