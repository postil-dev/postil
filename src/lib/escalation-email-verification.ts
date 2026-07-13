import { timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import {
  createEmailVerification,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_TOKEN_PATTERN,
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  emailVerificationJobPayload,
  emailVerificationUrl,
  normalizeVerificationEmail,
  sanitizeVerificationLabel,
  sendVerificationEmail,
  verificationTokenDigest,
  type VerificationTokenState,
} from "@/lib/email-verification";

export const ESCALATION_EMAIL_TOKEN_TTL_MS = EMAIL_VERIFICATION_TOKEN_TTL_MS;
export const ESCALATION_EMAIL_RESEND_COOLDOWN_MS = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS;

export interface VerificationResult {
  verified: boolean;
  slug: string | null;
}

export function normalizeEscalationEmail(value: string): string | null {
  return normalizeVerificationEmail(value, "Enter a valid notification email.");
}

export function escalationEmailTokenDigest(
  orgId: number,
  normalizedEmail: string,
  token: string,
): Buffer {
  return verificationTokenDigest("escalation-email", orgId, normalizedEmail, token);
}

export function createEscalationEmailVerification(
  orgId: number,
  normalizedEmail: string,
  now = new Date(),
): VerificationTokenState {
  return createEmailVerification("escalation-email", orgId, normalizedEmail, now);
}

export function escalationEmailVerificationJobPayload(
  orgId: number,
  tokenDigest: Buffer,
): { orgId: number; tokenDigest: string } {
  return emailVerificationJobPayload(orgId, tokenDigest);
}

export function escalationEmailVerificationUrl(
  publicOrigin: string,
  orgId: number,
  token: string,
): string {
  return emailVerificationUrl(publicOrigin, "/verify/escalation-email", orgId, token);
}

export async function verifyEscalationEmailToken(
  db: Database,
  orgId: number,
  token: string,
  now = new Date(),
): Promise<VerificationResult> {
  const row = (
    await db
      .select({
        slug: schema.organizations.slug,
        pendingEmail: schema.orgSettings.escalationEmailPending,
        tokenDigest: schema.orgSettings.escalationEmailVerificationTokenDigest,
        expiresAt: schema.orgSettings.escalationEmailVerificationExpiresAt,
      })
      .from(schema.organizations)
      .leftJoin(schema.orgSettings, eq(schema.orgSettings.orgId, schema.organizations.id))
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
  const expected = escalationEmailTokenDigest(orgId, row.pendingEmail, token);
  if (
    expected.length !== row.tokenDigest.length ||
    !timingSafeEqual(expected, row.tokenDigest)
  ) {
    return { verified: false, slug: row.slug };
  }

  const updated = await db
    .update(schema.orgSettings)
    .set({
      escalationEmail: row.pendingEmail,
      escalationEmailVerifiedAt: now,
      escalationEmailPending: null,
      escalationEmailVerificationTokenDigest: null,
      escalationEmailVerificationTokenCiphertext: null,
      escalationEmailVerificationExpiresAt: null,
      escalationEmailVerificationRequestedAt: null,
      escalationEmailVerificationSentAt: null,
      escalationEmailVerificationMessageId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.orgSettings.orgId, orgId),
        eq(schema.orgSettings.escalationEmailPending, row.pendingEmail),
        eq(schema.orgSettings.escalationEmailVerificationTokenDigest, row.tokenDigest),
        gt(schema.orgSettings.escalationEmailVerificationExpiresAt, now),
      ),
    )
    .returning({ orgId: schema.orgSettings.orgId });
  return { verified: updated.length === 1, slug: row.slug };
}

export async function sendEscalationEmailVerification(input: {
  recipient: string;
  orgName: string;
  verificationUrl: string;
  idempotencyKey: string;
  apiKey: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{ messageId: string | null }> {
  return sendVerificationEmail({
    recipient: input.recipient,
    subject: "Verify your Postil notification email",
    text: [
      `Verify this address to receive human escalation notifications for ${sanitizeVerificationLabel(input.orgName)}.`,
      "",
      `Verify email: ${input.verificationUrl}`,
    ],
    idempotencyKey: input.idempotencyKey,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
  });
}
