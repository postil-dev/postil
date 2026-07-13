import { timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  createEmailVerification,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_TOKEN_PATTERN,
  emailVerificationJobPayload,
  emailVerificationUrl,
  normalizeVerificationEmail,
  sanitizeVerificationLabel,
  sendVerificationEmail,
  verificationTokenDigest,
  type VerificationTokenState,
} from "@/lib/email-verification";

const PURPOSE = "billing-contact";

export const BILLING_CONTACT_RESEND_COOLDOWN_MS = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS;

export interface BillingContactVerificationResult {
  verified: boolean;
  slug: string | null;
}

export function normalizeBillingContact(value: string): string | null {
  return normalizeVerificationEmail(value, "Enter a valid billing email.");
}

export function billingContactTokenDigest(
  orgId: number,
  normalizedEmail: string,
  token: string,
): Buffer {
  return verificationTokenDigest(PURPOSE, orgId, normalizedEmail, token);
}

export function createBillingContactVerification(
  orgId: number,
  normalizedEmail: string,
  now = new Date(),
): VerificationTokenState {
  return createEmailVerification(PURPOSE, orgId, normalizedEmail, now);
}

export function billingContactVerificationJobPayload(
  orgId: number,
  tokenDigest: Buffer,
): { orgId: number; tokenDigest: string } {
  return emailVerificationJobPayload(orgId, tokenDigest);
}

export function billingContactVerificationUrl(
  publicOrigin: string,
  orgId: number,
  token: string,
): string {
  return emailVerificationUrl(publicOrigin, "/verify/billing-contact", orgId, token);
}

export async function verifyBillingContactToken(
  db: Database,
  orgId: number,
  token: string,
  now = new Date(),
): Promise<BillingContactVerificationResult> {
  const row = (
    await db
      .select({
        slug: schema.organizations.slug,
        pendingEmail: schema.organizationEntitlements.billingContactPending,
        tokenDigest: schema.organizationEntitlements.billingContactVerificationTokenDigest,
        expiresAt: schema.organizationEntitlements.billingContactVerificationExpiresAt,
      })
      .from(schema.organizations)
      .leftJoin(
        schema.organizationEntitlements,
        eq(schema.organizationEntitlements.orgId, schema.organizations.id),
      )
      .where(eq(schema.organizations.id, orgId))
      .limit(1)
  )[0];
  if (!row) return { verified: false, slug: null };
  if (
    !row.pendingEmail ||
    !row.tokenDigest ||
    !row.expiresAt ||
    row.expiresAt <= now ||
    !EMAIL_VERIFICATION_TOKEN_PATTERN.test(token)
  ) {
    return { verified: false, slug: row.slug };
  }
  const expected = billingContactTokenDigest(orgId, row.pendingEmail, token);
  if (
    expected.length !== row.tokenDigest.length ||
    !timingSafeEqual(expected, row.tokenDigest)
  ) {
    return { verified: false, slug: row.slug };
  }
  const updated = await db
    .update(schema.organizationEntitlements)
    .set({
      billingContactEmail: row.pendingEmail,
      billingContactVerifiedAt: now,
      billingContactPending: null,
      billingContactVerificationTokenDigest: null,
      billingContactVerificationTokenCiphertext: null,
      billingContactVerificationExpiresAt: null,
      billingContactVerificationRequestedAt: null,
      billingContactVerificationSentAt: null,
      billingContactVerificationMessageId: null,
      updatedBy: "billing-contact-verification",
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.organizationEntitlements.orgId, orgId),
        eq(schema.organizationEntitlements.billingContactPending, row.pendingEmail),
        eq(schema.organizationEntitlements.billingContactVerificationTokenDigest, row.tokenDigest),
        gt(schema.organizationEntitlements.billingContactVerificationExpiresAt, now),
      ),
    )
    .returning({ orgId: schema.organizationEntitlements.orgId });
  return { verified: updated.length === 1, slug: row.slug };
}

export async function sendBillingContactVerification(input: {
  recipient: string;
  orgName: string;
  verificationUrl: string;
  idempotencyKey: string;
  apiKey: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{ messageId: string | null }> {
  return sendVerificationEmail({
    recipient: input.recipient,
    subject: "Verify your Postil billing contact",
    text: [
      `Verify this address as the billing contact for ${sanitizeVerificationLabel(input.orgName)}.`,
      "",
      `Verify billing contact: ${input.verificationUrl}`,
    ],
    idempotencyKey: input.idempotencyKey,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
  });
}
