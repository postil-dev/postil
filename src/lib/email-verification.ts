import { createHash, randomBytes } from "node:crypto";

import { getSealingKey, seal } from "@/lib/crypto/seal";
import { optionalEnv } from "@/lib/env";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const TOKEN_BYTES = 32;
export const EMAIL_VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1_000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VerificationTokenState {
  token: string;
  tokenDigest: Buffer;
  tokenCiphertext: Buffer;
  expiresAt: Date;
  requestedAt: Date;
}

export function normalizeVerificationEmail(value: string, errorMessage: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(errorMessage);
  }
  return normalized;
}

export function verificationTokenDigest(
  purpose: string,
  orgId: number,
  normalizedEmail: string,
  token: string,
): Buffer {
  return createHash("sha256")
    .update(`postil-${purpose}:v1\0`, "utf8")
    .update(String(orgId), "utf8")
    .update("\0", "utf8")
    .update(normalizedEmail, "utf8")
    .update("\0", "utf8")
    .update(token, "utf8")
    .digest();
}

export function createEmailVerification(
  purpose: string,
  orgId: number,
  normalizedEmail: string,
  now = new Date(),
): VerificationTokenState {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenDigest: verificationTokenDigest(purpose, orgId, normalizedEmail, token),
    tokenCiphertext: seal(token, getSealingKey()),
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
    requestedAt: now,
  };
}

export function emailVerificationUrl(
  publicOrigin: string,
  path: string,
  orgId: number,
  token: string,
): string {
  const url = new URL(path, publicOrigin);
  url.searchParams.set("org", String(orgId));
  url.searchParams.set("token", token);
  return url.toString();
}

export function emailVerificationJobPayload(
  orgId: number,
  tokenDigest: Buffer,
): { orgId: number; tokenDigest: string } {
  return { orgId, tokenDigest: tokenDigest.toString("base64url") };
}

export async function sendVerificationEmail(input: {
  recipient: string;
  subject: string;
  text: string[];
  idempotencyKey: string;
  apiKey: string;
  fetchImpl?: Fetch;
}): Promise<{ messageId: string | null }> {
  return sendTransactionalEmail({
    ...input,
    text: [
      ...input.text,
      "",
      "This link expires in 24 hours. If you did not request this, ignore it.",
    ],
  });
}

export async function sendTransactionalEmail(input: {
  recipient: string;
  subject: string;
  text: string[];
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
        name:
          optionalEnv("POSTIL_EMAIL_FROM_NAME") ??
          (optionalEnv("POSTIL_ESCALATION_FROM_NAME", "Postil") as string),
        email:
          optionalEnv("POSTIL_EMAIL_FROM_EMAIL") ??
          (optionalEnv(
            "POSTIL_ESCALATION_FROM_EMAIL",
            "reviews@mail.postil.dev",
          ) as string),
      },
      to: [{ email: input.recipient }],
      subject: input.subject,
      textContent: input.text.join("\n"),
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
    throw new Error(`Brevo transactional email failed: ${response.status}`);
  }
  return { messageId: typeof parsed.messageId === "string" ? parsed.messageId : null };
}

export function sanitizeVerificationLabel(value: string, maxChars = 160): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
