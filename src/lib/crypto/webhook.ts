import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook signature verification (X-Hub-Signature-256).
 *
 * Runs against the raw request body BEFORE any JSON parsing, with a
 * timing-safe comparison. Returns false for missing/malformed headers
 * rather than throwing, so the route can reply 401 uniformly.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  if (provided.length !== expected.length) return false;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

/** Compute the header value (used by tests and local tooling). */
export function signWebhookBody(rawBody: string | Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
