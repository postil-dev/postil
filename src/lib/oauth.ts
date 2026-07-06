export const OAUTH_STATE_COOKIE = "postil_oauth_state";
export const OAUTH_CALLBACK_PATH = "/api/auth/callback";

export function oauthCallbackUrl(request: Request): string {
  return `${publicOrigin(request)}${OAUTH_CALLBACK_PATH}`;
}

function publicOrigin(request: Request): string {
  const configuredOrigin = process.env.POSTIL_PUBLIC_URL?.trim();
  if (configuredOrigin) return normalizeOrigin(configuredOrigin, "POSTIL_PUBLIC_URL");

  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  if (forwardedHost) {
    const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto")) ?? "https";
    return normalizeOrigin(`${forwardedProto}://${forwardedHost}`, "forwarded request headers");
  }

  return new URL(request.url).origin;
}

function normalizeOrigin(value: string, source: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${source} must use http or https`);
  }
  return url.origin;
}

function firstHeaderValue(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}
