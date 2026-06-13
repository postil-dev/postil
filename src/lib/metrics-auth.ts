import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer-token check for the metrics endpoint.
 *
 * A length pre-check runs first: timingSafeEqual throws on unequal-length
 * buffers, and that throw would itself leak length, so an unequal length
 * short-circuits to false. The constant-time byte compare then covers the full
 * `Bearer <token>` header so the comparison time does not depend on how many
 * leading bytes match. Mirrors the webhook signature verification's timing-safe
 * discipline (src/lib/crypto/webhook.ts).
 */
export function bearerMatches(authHeader: string, token: string): boolean {
  const expected = `Bearer ${token}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
