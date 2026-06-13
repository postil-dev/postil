import { describe, expect, test } from "bun:test";

import { bearerMatches } from "@/lib/metrics-auth";

/**
 * Constant-time bearer comparison (L1). Behavioural correctness is asserted
 * here; the timing-safety itself comes from node:crypto timingSafeEqual on
 * equal-length buffers, guarded by a length pre-check (an unequal length
 * short-circuits to false instead of letting timingSafeEqual throw).
 */
describe("metrics bearer auth", () => {
  const TOKEN = "s3cr3t-metrics-token";

  test("accepts the exact Bearer token", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  test("rejects a wrong token of the same length", () => {
    const wrong = "x".repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length);
    expect(bearerMatches(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  test("rejects a token that differs only in the last byte", () => {
    const off = `${TOKEN.slice(0, -1)}X`;
    expect(off.length).toBe(TOKEN.length);
    expect(bearerMatches(`Bearer ${off}`, TOKEN)).toBe(false);
  });

  test("rejects missing, empty, and malformed headers without throwing", () => {
    expect(bearerMatches("", TOKEN)).toBe(false);
    expect(bearerMatches("Bearer", TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false); // missing the scheme prefix
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false); // wrong-case scheme
    expect(bearerMatches(`Bearer ${TOKEN} `, TOKEN)).toBe(false); // trailing space
    expect(bearerMatches(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false); // longer
  });
});
