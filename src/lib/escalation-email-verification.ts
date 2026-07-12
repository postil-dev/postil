import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { getSealingKey, seal } from "@/lib/crypto/seal";
import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import { optionalEnv } from "@/lib/env";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const ESCALATION_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
export const ESCALATION_EMAIL_RESEND_COOLDOWN_MS = 60 * 1_000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VerificationTokenState {
  token: string;
  tokenDigest: Buffer;
  tokenCiphertext: Buffer;
  expiresAt: Date;
  requestedAt: Date;
}

export interface VerificationResult {
  verified: boolean;
  slug: string | null;
}

export function normalizeEscalationEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new Error("Enter a valid notification email.");
  }
  return normalized;
}

export function escalationEmailTokenDigest(
  orgId: number,
  normalizedEmail: string,
  token: string,
): Buffer {
  return createHash("sha256")
    .update("postil-escalation-email:v1\0", "utf8")
    .update(String(orgId), "utf8")
    .update("\0", "utf8")
    .update(normalizedEmail, "utf8")
    .update("\0", "utf8")
    .update(token, "utf8")
    .digest();
}

export function createEscalationEmailVerification(
  orgId: number,
  normalizedEmail: string,
  now = new Date(),
): VerificationTokenState {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenDigest: escalationEmailTokenDigest(orgId, normalizedEmail, token),
    tokenCiphertext: seal(token, getSealingKey()),
    expiresAt: new Date(now.getTime() + ESCALATION_EMAIL_TOKEN_TTL_MS),
    requestedAt: now,
  };
}

export function escalationEmailVerificationJobPayload(
  orgId: number,
  tokenDigest: Buffer,
): { orgId: number; tokenDigest: string } {
  return { orgId, tokenDigest: tokenDigest.toString("base64url") };
}

export function escalationEmailVerificationUrl(
  publicOrigin: string,
  orgId: number,
  token: string,
): string {
  const url = new URL("/verify/escalation-email", publicOrigin);
  url.searchParams.set("org", String(orgId));
  url.searchParams.set("token", token);
  return url.toString();
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
    !TOKEN_PATTERN.test(token)
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
  fetchImpl?: Fetch;
}): Promise<{ messageId: string | null }> {
  const response = await (input.fetchImpl ?? fetch)(BREVO_SEND_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": input.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: {
        name: optionalEnv("POSTIL_ESCALATION_FROM_NAME", "Postil") as string,
        email: optionalEnv(
          "POSTIL_ESCALATION_FROM_EMAIL",
          "reviews@mail.postil.dev",
        ) as string,
      },
      to: [{ email: input.recipient }],
      subject: "Verify your Postil notification email",
      textContent: [
        `Verify this address to receive human escalation notifications for ${sanitizeSingleLine(input.orgName, 160)}.`,
        "",
        `Verify email: ${input.verificationUrl}`,
        "",
        "This link expires in 24 hours. If you did not request this, ignore it.",
      ].join("\n"),
      headers: { "Idempotency-Key": input.idempotencyKey },
    }),
    signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
  });

  const responseText = await response.text();
  let parsed: { code?: unknown; messageId?: unknown } = {};
  try {
    parsed = JSON.parse(responseText) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (!response.ok && parsed.code !== "duplicate_parameter") {
    throw new Error(`Brevo verification email failed: ${response.status}`);
  }
  return {
    messageId: typeof parsed.messageId === "string" ? parsed.messageId : null,
  };
}

function sanitizeSingleLine(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
