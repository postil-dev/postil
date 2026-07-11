/**
 * Session token signing/verification.
 *
 * Token format: `<sessionId>.<base64url HMAC-SHA256(sessionId)>`. Uses Web
 * Crypto and no Node builtins so the same code runs in the Next.js
 * middleware (edge runtime), route handlers, and the Bun worker. The HMAC
 * only authenticates that the cookie was minted by us; authorization still
 * checks the sessions table.
 */

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSessionToken(sessionId: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionId));
  return `${sessionId}.${toBase64url(new Uint8Array(mac))}`;
}

/** Returns true for session cookies with this app's minted token shape. */
export function isSessionTokenFormat(token: string | undefined): token is string {
  return typeof token === "string" && SESSION_TOKEN_PATTERN.test(token);
}

/** Returns the sessionId when the signature is valid, otherwise null. */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = token.slice(0, dot);
  const macBytes = fromBase64url(token.slice(dot + 1));
  if (!macBytes || macBytes.length === 0) return null;
  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    macBytes as BufferSource,
    new TextEncoder().encode(sessionId),
  );
  return valid ? sessionId : null;
}

export const SESSION_COOKIE = "postil_session";
