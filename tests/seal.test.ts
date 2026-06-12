import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { parseSealingKey, seal, unseal } from "@/lib/crypto/seal";

describe("AES-256-GCM sealing", () => {
  const key = randomBytes(32);

  test("round-trips a plaintext key", () => {
    const sealed = seal("sk-or-v1-abc123", key);
    expect(unseal(sealed, key)).toBe("sk-or-v1-abc123");
  });

  test("produces a fresh IV per seal (no deterministic ciphertext)", () => {
    const a = seal("same-plaintext", key);
    const b = seal("same-plaintext", key);
    expect(a.equals(b)).toBe(false);
  });

  test("rejects tampered ciphertext (auth tag)", () => {
    const sealed = seal("secret", key);
    const lastIndex = sealed.length - 1;
    const tampered = Buffer.from(sealed);
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xff;
    expect(() => unseal(tampered, key)).toThrow();
  });

  test("rejects the wrong key", () => {
    const sealed = seal("secret", key);
    expect(() => unseal(sealed, randomBytes(32))).toThrow();
  });

  test("rejects truncated payloads and bad key sizes", () => {
    expect(() => unseal(Buffer.from("short"), key)).toThrow("too short");
    expect(() => seal("x", randomBytes(16))).toThrow("32 bytes");
  });

  test("parseSealingKey accepts hex and base64, rejects junk", () => {
    const hex = randomBytes(32).toString("hex");
    expect(parseSealingKey(hex).length).toBe(32);
    const b64 = randomBytes(32).toString("base64");
    expect(parseSealingKey(b64).length).toBe(32);
    expect(() => parseSealingKey("not-a-key")).toThrow("POSTIL_SEALING_KEY");
    // Round trip through both encodings yields the same key bytes.
    const raw = randomBytes(32);
    expect(parseSealingKey(raw.toString("hex")).equals(raw)).toBe(true);
    expect(parseSealingKey(raw.toString("base64")).equals(raw)).toBe(true);
  });
});
