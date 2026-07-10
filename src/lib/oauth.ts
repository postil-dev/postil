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

  return new URL(request.url).origin;
}

export function configuredPublicOrigin(): string | undefined {
  const configuredOrigin = process.env.POSTIL_PUBLIC_URL?.trim();
  if (!configuredOrigin) return undefined;
  return normalizeOrigin(configuredOrigin, "POSTIL_PUBLIC_URL");
}

function normalizeOrigin(value: string, source: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${source} must use http or https`);
  }
  return url.origin;
}
