export const OAUTH_STATE_COOKIE = "postil_oauth_state";
export const OAUTH_CALLBACK_PATH = "/api/auth/callback";

export function oauthCallbackUrl(request: Request): string {
  return `${publicOrigin(request)}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Origin to use in URLs handed to the browser or to GitHub. Behind the Fly
 * proxy `request.url` reports the machine-internal origin (localhost:3000),
 * so production must set POSTIL_PUBLIC_URL; the request origin is only a
 * fallback for local development.
 */
export function publicOrigin(request: Request): string {
  const configuredOrigin = configuredPublicOrigin();
  if (configuredOrigin) return configuredOrigin;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "POSTIL_PUBLIC_URL is required in production; refusing to derive a public origin from request headers",
    );
  }
  return new URL(request.url).origin;
}

/**
 * Canonical public URL for the requested path and query string. The configured
 * origin is authoritative behind a reverse proxy; forwarded host and protocol
 * headers are intentionally ignored because they can be supplied by clients.
 */
export function publicRequestUrl(request: Request): URL {
  const internalUrl = new URL(request.url);
  const url = new URL(publicOrigin(request));
  url.pathname = internalUrl.pathname;
  url.search = internalUrl.search;
  return url;
}

export function configuredPublicOrigin(): string | undefined {
  const configuredOrigin = process.env.POSTIL_PUBLIC_URL?.trim();
  if (!configuredOrigin) return undefined;
  return normalizeOrigin(configuredOrigin, "POSTIL_PUBLIC_URL");
}

function normalizeOrigin(value: string, source: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error(`${source} must not contain credentials`);
  }
  if (url.pathname !== "/" || url.href !== `${url.origin}/`) {
    throw new Error(`${source} must be an origin without a path, query, or fragment`);
  }
  if (url.protocol === "http:" && isLocalDevelopmentHost(url.hostname)) {
    return url.origin;
  }
  if (url.protocol !== "https:") {
    throw new Error(`${source} must use https (http is allowed only for local development)`);
  }
  return url.origin;
}

function isLocalDevelopmentHost(hostname: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
