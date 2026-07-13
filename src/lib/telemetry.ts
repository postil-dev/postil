const ALLOWED_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "gad_source",
  "ref",
]);

const PUBLIC_EXACT_PATHS = new Set([
  "/",
  "/blog",
  "/changelog",
  "/contact",
  "/docs",
  "/evidence",
  "/how-it-works",
  "/install",
  "/pricing",
  "/privacy",
  "/robots.txt",
  "/security",
  "/sitemap.xml",
  "/terms",
  "/why-postil",
]);

const PUBLIC_PREFIXES = ["/blog/", "/docs/", "/vs/"];

export function isPublicTelemetryPath(pathname: string): boolean {
  return (
    PUBLIC_EXACT_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function sanitizedPublicUrl(source: URL | string): string {
  const url = new URL(source.toString());
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

export function sanitizedReferrer(
  referrer: string | null | undefined,
  currentOrigin: string,
): string | undefined {
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    url.hash = "";
    if (url.origin === currentOrigin) {
      return isPublicTelemetryPath(url.pathname) ? sanitizedPublicUrl(url) : undefined;
    }
    const out = new URL(url.origin);
    for (const key of ALLOWED_QUERY_PARAMS) {
      const value = url.searchParams.get(key);
      if (value) out.searchParams.set(key, value);
    }
    return out.toString();
  } catch {
    return undefined;
  }
}

export function campaignProperties(url: URL): Record<string, string | undefined> {
  return {
    $utm_source: url.searchParams.get("utm_source") ?? undefined,
    $utm_medium: url.searchParams.get("utm_medium") ?? undefined,
    $utm_campaign: url.searchParams.get("utm_campaign") ?? undefined,
    $utm_content: url.searchParams.get("utm_content") ?? undefined,
    $utm_term: url.searchParams.get("utm_term") ?? undefined,
    ref: url.searchParams.get("ref") ?? undefined,
  };
}

export function publicTelemetryProperties(
  currentUrl: URL | string,
  referrer?: string | null,
): Record<string, string | number | boolean> | undefined {
  const url = new URL(currentUrl.toString());
  if (!isPublicTelemetryPath(url.pathname)) return undefined;
  return removeEmpty({
    $current_url: sanitizedPublicUrl(url),
    $host: url.host,
    $pathname: url.pathname,
    $referrer: sanitizedReferrer(referrer, url.origin),
    ...campaignProperties(url),
  });
}

export function sanitizePostHogProperties(
  properties: Record<string, unknown>,
  currentOrigin: string,
): Record<string, unknown> {
  delete properties.$ip;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== "string") continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("referrer")) {
      const sanitized = sanitizedReferrer(value, currentOrigin);
      if (sanitized) properties[key] = sanitized;
      else delete properties[key];
      continue;
    }
    if (lowerKey.includes("url")) {
      const sanitized = sanitizedTelemetryUrl(value, currentOrigin);
      if (sanitized) properties[key] = sanitized;
      else delete properties[key];
    }
  }
  return properties;
}

const WEB_VITAL_EVENT_KEY = /^\$web_vitals_(?:LCP|CLS|FCP|INP)_event$/;
const WEB_VITAL_EVENT_FIELDS = new Set([
  "name",
  "value",
  "rating",
  "delta",
  "navigationType",
  "$current_url",
  "timestamp",
]);

/**
 * Keep Web Vitals limited to numeric metric data for public pages. PostHog's
 * nested metric payload can include PerformanceEntry objects and raw URLs,
 * which are unnecessary for aggregate Core Web Vitals reporting.
 */
export function sanitizePostHogWebVitalsProperties(
  properties: Record<string, unknown>,
  currentOrigin: string,
): boolean {
  let eventCount = 0;
  for (const [key, value] of Object.entries(properties)) {
    if (!WEB_VITAL_EVENT_KEY.test(key)) continue;
    if (!isRecord(value)) return false;
    const currentUrl = value.$current_url;
    if (typeof currentUrl !== "string") return false;
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(currentUrl);
    } catch {
      return false;
    }
    if (sourceUrl.origin !== currentOrigin || !isPublicTelemetryPath(sourceUrl.pathname)) {
      return false;
    }
    const sanitizedUrl = sanitizedTelemetryUrl(currentUrl, currentOrigin);
    if (!sanitizedUrl) return false;

    properties[key] = Object.fromEntries(
      Object.entries({ ...value, $current_url: sanitizedUrl }).filter(
        ([field, fieldValue]) =>
          WEB_VITAL_EVENT_FIELDS.has(field) &&
          (typeof fieldValue === "string" || typeof fieldValue === "number"),
      ),
    );
    eventCount += 1;
  }
  return eventCount > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedTelemetryUrl(value: string, currentOrigin: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.origin === currentOrigin) {
      if (isPublicTelemetryPath(url.pathname)) return sanitizedPublicUrl(url);
      return new URL(url.origin).toString();
    }
    return sanitizedReferrer(value, currentOrigin);
  } catch {
    return undefined;
  }
}

export function removeEmpty(
  input: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1];
      return value !== undefined && value !== null && value !== "";
    }),
  );
}
