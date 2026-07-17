import { createHmac, timingSafeEqual } from "node:crypto";

export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 25 * 1024 * 1024;

export type WebhookBodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: 400 | 413 };

/**
 * Read a request body without ever buffering more than the configured limit.
 * GitHub caps webhook payloads at 25 MiB, but the receiver enforces that bound
 * independently because Content-Length can be absent or dishonest.
 */
export async function readBoundedWebhookBody(
  request: Request,
  maxBytes = GITHUB_WEBHOOK_MAX_BODY_BYTES,
): Promise<WebhookBodyReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("webhook body limit must be a positive safe integer");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return { ok: false, status: 400 };
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) return { ok: false, status: 400 };
    if (declaredBytes > maxBytes) return { ok: false, status: 413 };
  }

  if (!request.body) return { ok: true, body: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(chunk.value);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }

  return { ok: true, body: Buffer.concat(chunks, bytesRead) };
}

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
