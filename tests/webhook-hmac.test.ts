import { describe, expect, test } from "bun:test";

import { signWebhookBody, verifyWebhookSignature } from "@/lib/crypto/webhook";

const SECRET = "test-webhook-secret";

describe("webhook signature verification", () => {
  test("accepts a correctly signed body", () => {
    const body = JSON.stringify({ action: "opened", number: 7 });
    const header = signWebhookBody(body, SECRET);
    expect(header.startsWith("sha256=")).toBe(true);
    expect(verifyWebhookSignature(body, header, SECRET)).toBe(true);
  });

  test("rejects a tampered body", () => {
    const body = JSON.stringify({ action: "opened", number: 7 });
    const header = signWebhookBody(body, SECRET);
    const tampered = JSON.stringify({ action: "opened", number: 8 });
    expect(verifyWebhookSignature(tampered, header, SECRET)).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    const body = "payload";
    const header = signWebhookBody(body, "other-secret");
    expect(verifyWebhookSignature(body, header, SECRET)).toBe(false);
  });

  test("rejects missing, malformed, and wrong-length headers", () => {
    const body = "payload";
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abcdef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=deadbeef", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=not-hex-at-all-but-right-length-0000000000000000000000000000000000", SECRET)).toBe(false);
  });

  test("verifies against the raw bytes, not parsed JSON", () => {
    // Same JSON value, different raw encoding: signature must not transfer.
    const compact = '{"a":1}';
    const spaced = '{ "a": 1 }';
    const header = signWebhookBody(compact, SECRET);
    expect(verifyWebhookSignature(spaced, header, SECRET)).toBe(false);
  });
});
