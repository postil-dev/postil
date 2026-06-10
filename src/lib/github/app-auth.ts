import { createSign } from "node:crypto";

import { optionalEnv, requireEnv } from "@/lib/env";

/**
 * GitHub App authentication.
 *
 * App JWT (RS256, 10 minute lifetime) -> installation access token. Tokens
 * are cached in memory only and never persisted; the private key never
 * leaves the env and is never logged.
 */

const GITHUB_API = "https://api.github.com";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Accepts raw PEM or base64-encoded PEM in GITHUB_APP_PRIVATE_KEY. */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    // Support \n-escaped single-line PEM from .env files.
    return trimmed.replace(/\\n/g, "\n");
  }
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;
  throw new Error(
    "GITHUB_APP_PRIVATE_KEY is neither a PEM block nor base64-encoded PEM",
  );
}

export function buildAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const nowSec = Math.floor(now / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  // 60s clock-drift backdate, 10 minute expiry (GitHub maximum).
  const payload = base64urlJson({ iat: nowSec - 60, exp: nowSec + 540, iss: appId });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<number, CachedToken>();

/** Mint (or reuse) an installation access token. In-memory cache only. */
export async function getInstallationToken(githubInstallationId: number): Promise<string> {
  const cached = tokenCache.get(githubInstallationId);
  // Refresh 5 minutes before expiry.
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }
  const appId = requireEnv("GITHUB_APP_ID");
  const privateKey = normalizePrivateKey(requireEnv("GITHUB_APP_PRIVATE_KEY"));
  const jwt = buildAppJwt(appId, privateKey);
  const res = await fetch(
    `${apiBase()}/app/installations/${githubInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "postil-control-plane",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to mint installation token for installation ${githubInstallationId}: HTTP ${res.status} ${truncate(body)}`,
    );
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(githubInstallationId, {
    token: data.token,
    expiresAt: Date.parse(data.expires_at),
  });
  return data.token;
}

/**
 * GITHUB_API_URL is the one knob for GHES: the worker uses it here and the
 * spawned CLI reads the same variable from its inherited environment.
 */
export function apiBase(): string {
  return optionalEnv("GITHUB_API_URL", GITHUB_API) as string;
}

function truncate(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** Test hook: clear the in-memory token cache. */
export function clearTokenCache(): void {
  tokenCache.clear();
}
