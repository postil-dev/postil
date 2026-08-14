export const OAUTH_STATE_COOKIE = "postil_oauth_state";
export const OAUTH_RETURN_TO_COOKIE = "postil_oauth_return_to";
export const GITHUB_SETUP_INSTALLATION_COOKIE = "postil_setup_installation";
export const OAUTH_CALLBACK_PATH = "/api/auth/callback";

const RETURN_TARGET_BASE = "https://postil.invalid";
const MAX_ORGANIZATION_SETTINGS_URL_LENGTH = 2_048;

/**
 * Accept a same-site account path for the post-authentication redirect.
 * Keeping the allowlist aligned with middleware prevents open redirects,
 * redirect loops, and unexpected API navigation.
 */
export function safeReturnTarget(
  value: string | null | undefined,
): string | undefined {
  if (
    !value ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value, RETURN_TARGET_BASE);
  } catch {
    return undefined;
  }
  if (url.origin !== RETURN_TARGET_BASE || url.username || url.password) return undefined;
  if (!isProtectedAccountPath(url.pathname)) {
    return undefined;
  }
  return `${url.pathname}${url.search}`;
}

function isProtectedAccountPath(pathname: string): boolean {
  return (
    pathname === "/operator" ||
    pathname.startsWith("/operator/") ||
    pathname === "/reports" ||
    pathname.startsWith("/reports/") ||
    pathname.startsWith("/orgs/") ||
    pathname === "/cli/authorize"
  );
}

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

/** Build the authenticated dashboard URL for one persisted review. */
export function reviewDetailsUrl(
  publicId: string,
  orgSlug: string | null | undefined,
): string | undefined {
  const origin = configuredPublicOrigin();
  if (!origin || !orgSlug) return undefined;
  return new URL(
    `/orgs/${encodeURIComponent(orgSlug)}/runs/${encodeURIComponent(publicId)}`,
    origin,
  ).toString();
}

/** Build a dashboard link to the authenticated settings for one organization. */
export function organizationSettingsUrl(
  orgSlug: string | null | undefined,
): string | undefined {
  const origin = configuredPublicOrigin();
  if (!origin || !orgSlug) return undefined;
  const expectedPath = `/orgs/${encodeURIComponent(orgSlug)}/settings`;
  const url = new URL(expectedPath, origin);
  if (url.pathname !== expectedPath) return undefined;
  const href = url.toString();
  return href.length <= MAX_ORGANIZATION_SETTINGS_URL_LENGTH ? href : undefined;
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
