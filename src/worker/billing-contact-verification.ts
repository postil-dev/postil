import { and, eq, gt } from "drizzle-orm";

import {
  billingContactVerificationUrl,
  sendBillingContactVerification,
} from "@/lib/billing-contact-verification";
import { getSealingKey, unseal } from "@/lib/crypto/seal";
import { getDb, schema } from "@/lib/db";
import { requireEnv } from "@/lib/env";

export interface BillingContactVerificationJobPayload extends Record<string, unknown> {
  orgId: number;
  tokenDigest: string;
}

export async function runBillingContactVerificationJob(
  payload: BillingContactVerificationJobPayload,
): Promise<void> {
  validatePayload(payload);
  const expectedDigest = Buffer.from(payload.tokenDigest, "base64url");
  const db = getDb();
  const now = new Date();
  const row = (
    await db
      .select({
        orgName: schema.organizations.name,
        pendingEmail: schema.organizationEntitlements.billingContactPending,
        tokenDigest: schema.organizationEntitlements.billingContactVerificationTokenDigest,
        tokenCiphertext:
          schema.organizationEntitlements.billingContactVerificationTokenCiphertext,
        expiresAt: schema.organizationEntitlements.billingContactVerificationExpiresAt,
      })
      .from(schema.organizationEntitlements)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.organizationEntitlements.orgId),
      )
      .where(eq(schema.organizationEntitlements.orgId, payload.orgId))
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
  const result = await sendBillingContactVerification({
    recipient: row.pendingEmail,
    orgName: row.orgName,
    verificationUrl: billingContactVerificationUrl(
      requireEnv("POSTIL_PUBLIC_URL"),
      payload.orgId,
      token,
    ),
    idempotencyKey: `billing-contact-verification-${payload.tokenDigest}`,
    apiKey: requireEnv("BREVO_API_KEY"),
  });
  await db
    .update(schema.organizationEntitlements)
    .set({
      billingContactVerificationSentAt: new Date(),
      billingContactVerificationMessageId: result.messageId,
      updatedBy: "billing-contact-verification-delivery",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.organizationEntitlements.orgId, payload.orgId),
        eq(schema.organizationEntitlements.billingContactVerificationTokenDigest, expectedDigest),
        gt(schema.organizationEntitlements.billingContactVerificationExpiresAt, now),
      ),
    );
}

function validatePayload(payload: BillingContactVerificationJobPayload): void {
  if (
    !Number.isSafeInteger(payload.orgId) ||
    payload.orgId <= 0 ||
    typeof payload.tokenDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.tokenDigest)
  ) {
    throw new Error("billing contact verification job payload is malformed");
  }
}
