import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM sealing for org BYO API keys.
 *
 * Wire format: [12-byte IV][16-byte auth tag][ciphertext]. The sealing key
 * comes from POSTIL_SEALING_KEY (32 bytes, hex or base64). Plaintext keys
 * are never logged and never returned to the browser; the settings form is
 * write-only.
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function parseSealingKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === 32) return b64;
  throw new Error(
    "POSTIL_SEALING_KEY must be 32 bytes, encoded as 64 hex chars or base64 (try: openssl rand -hex 32)",
  );
}

export function seal(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("sealing key must be exactly 32 bytes");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function unseal(sealed: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error("sealing key must be exactly 32 bytes");
  if (sealed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("sealed payload too short");
  }
  const iv = sealed.subarray(0, IV_LENGTH);
  const tag = sealed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = sealed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function getSealingKey(): Buffer {
  const raw = process.env.POSTIL_SEALING_KEY;
  if (!raw) {
    throw new Error(
      "POSTIL_SEALING_KEY is not set; cannot seal or unseal org API keys (try: openssl rand -hex 32)",
    );
  }
  return parseSealingKey(raw);
}
