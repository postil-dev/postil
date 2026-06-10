/**
 * AES-256-GCM helpers using the WebCrypto API. The review-token secret encrypts
 * the GitHub App installation token before we hand it to the worker, so a
 * compromised worker queue cannot replay a long-lived credential.
 *
 * The key is derived deterministically from REVIEW_TOKEN_SECRET via SHA-256;
 * any 32-byte key material works.
 */

import { env } from "./env";

async function keyFromSecret(): Promise<CryptoKey> {
  const secret = env().REVIEW_TOKEN_SECRET;
  if (!secret) throw new Error("REVIEW_TOKEN_SECRET is not configured");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealToken(plaintext: string): Promise<string> {
  const key = await keyFromSecret();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return base64UrlEncode(combined);
}

export async function unsealToken(token: string): Promise<string> {
  const key = await keyFromSecret();
  const combined = base64UrlDecode(token);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decoded);
}

/** Verify an HMAC-SHA256 signature from a GitHub webhook payload. */
export async function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) {
    mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(s: string): Uint8Array {
  let b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  while (b64.length % 4) b64 += "=";
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
