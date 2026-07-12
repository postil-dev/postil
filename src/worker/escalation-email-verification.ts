import { and, eq, gt } from "drizzle-orm";

import { getSealingKey, unseal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import {
  escalationEmailVerificationUrl,
  sendEscalationEmailVerification,
} from "@/lib/escalation-email-verification";
import { requireEnv } from "@/lib/env";

export interface EscalationEmailVerificationJobPayload
  extends Record<string, unknown> {
  orgId: number;
  tokenDigest: string;
}

export async function runEscalationEmailVerificationJob(
  payload: EscalationEmailVerificationJobPayload,
): Promise<void> {
  validatePayload(payload);
  const expectedDigest = Buffer.from(payload.tokenDigest, "base64url");
  const db = getDb();
  const now = new Date();
  const row = (
    await db
      .select({
        orgName: schema.organizations.name,
        pendingEmail: schema.orgSettings.escalationEmailPending,
        tokenDigest: schema.orgSettings.escalationEmailVerificationTokenDigest,
        tokenCiphertext:
          schema.orgSettings.escalationEmailVerificationTokenCiphertext,
        expiresAt: schema.orgSettings.escalationEmailVerificationExpiresAt,
      })
      .from(schema.orgSettings)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.orgSettings.orgId),
      )
      .where(eq(schema.orgSettings.orgId, payload.orgId))
      .limit(1)
  )[0];
  if (
    !row?.pendingEmail ||
    !row.tokenDigest ||
    !row.tokenCiphertext ||
    !row.expiresAt ||
    row.expiresAt <= now ||
    !row.tokenDigest.equals(expectedDigest)
  ) {
    return;
  }

  const token = unseal(row.tokenCiphertext, getSealingKey());
  const publicOrigin = requireEnv("POSTIL_PUBLIC_URL");
  const result = await sendEscalationEmailVerification({
    recipient: row.pendingEmail,
    orgName: row.orgName,
    verificationUrl: escalationEmailVerificationUrl(
      publicOrigin,
      payload.orgId,
      token,
    ),
    idempotencyKey: `escalation-email-verification-${payload.tokenDigest}`,
    apiKey: requireEnv("BREVO_API_KEY"),
  });
  await db
    .update(schema.orgSettings)
    .set({
      escalationEmailVerificationSentAt: new Date(),
      escalationEmailVerificationMessageId: result.messageId,
    })
    .where(
      and(
        eq(schema.orgSettings.orgId, payload.orgId),
        eq(schema.orgSettings.escalationEmailVerificationTokenDigest, expectedDigest),
        gt(schema.orgSettings.escalationEmailVerificationExpiresAt, now),
      ),
    );
}

function validatePayload(payload: EscalationEmailVerificationJobPayload): void {
  if (
    !Number.isSafeInteger(payload.orgId) ||
    payload.orgId <= 0 ||
    typeof payload.tokenDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.tokenDigest)
  ) {
    throw new Error("escalation email verification job payload is malformed");
  }
}
