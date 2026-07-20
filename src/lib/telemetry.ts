const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;
const CAMPAIGN_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;
const PAGE_ENGAGEMENT_PROPERTIES = new Set([
  "$prev_pageview_duration",
  "$prev_pageview_last_scroll",
  "$prev_pageview_last_scroll_percentage",
  "$prev_pageview_max_scroll",
  "$prev_pageview_max_scroll_percentage",
]);
const WEB_VITAL_EVENT_KEY = /^\$web_vitals_(?:LCP|CLS|FCP|INP)_event$/;
const WEB_VITAL_RATINGS = new Set(["good", "needs-improvement", "poor"]);
const WEB_VITAL_NAVIGATION_TYPES = new Set([
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "restore",
  "not-restored",
]);

// Keep this allowlist exact. Prefix matching can capture identifiers or secrets
// embedded in a future public-looking route before that route is reviewed.
const PUBLIC_EXACT_PATHS = new Set([
  "/",
  "/blog",
  "/blog/ai-code-review-benchmarks",
  "/blog/ai-code-review-pricing-2026",
  "/blog/best-ai-code-review-tools-2026",
  "/blog/evidence-has-to-link-back",
  "/blog/self-hosted-ai-code-review",
  "/blog/silence-rate",
  "/blog/the-gate-is-separate-from-the-review",
  "/blog/where-does-your-code-go",
  "/blog/why-copilot-cant-block-your-merge",
  "/changelog",
  "/contact",
  "/docs",
  "/docs/cli",
  "/docs/coding-agents",
  "/docs/config",
  "/docs/content-policy",
  "/docs/envelope",
  "/docs/exit-codes",
  "/docs/forges",
  "/docs/forges/azure",
  "/docs/forges/bitbucket",
  "/docs/forges/github",
  "/docs/forges/gitlab",
  "/docs/gate",
  "/docs/models",
  "/docs/plan",
  "/docs/quickstart",
  "/docs/self-hosted",
  "/evidence",
  "/how-it-works",
  "/install",
  "/pricing",
  "/privacy",
  "/robots.txt",
  "/security",
  "/sitemap.xml",
  "/terms",
  "/vs/coderabbit",
  "/vs/copilot",
  "/vs/greptile",
  "/vs/macroscope",
  "/vs/qodo",
  "/why-postil",
]);

type BrowserTelemetryEvent = "$pageview" | "$pageleave" | "$web_vitals";

export function isPublicTelemetryPath(pathname: string): boolean {
  return PUBLIC_EXACT_PATHS.has(pathname);
}

export function sanitizedPublicUrl(source: URL | string): string {
  const url = new URL(source.toString());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Public telemetry URLs must use HTTP or HTTPS.");
  }
  return `${url.origin}${url.pathname}`;
}

export function sanitizedReferrer(
  referrer: string | null | undefined,
  _currentOrigin: string,
): string | undefined {
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.origin}/`;
  } catch {
    return undefined;
  }
}

export function campaignProperties(url: URL): Record<string, string | undefined> {
  return Object.fromEntries(
    CAMPAIGN_KEYS.map((key) => [
      `$${key}`,
      sanitizeCampaignValue(url.searchParams.get(key)),
    ]),
  );
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

/**
 * Rebuild a browser event from a small allowlist. PostHog adds many automatic
 * properties before this hook runs, so deleting selected keys is not enough to
 * prevent a future SDK release from expanding the payload.
 */
export function sanitizePostHogEventProperties(
  eventName: BrowserTelemetryEvent,
  properties: Record<string, unknown>,
  currentOrigin: string,
  projectToken: string,
): boolean {
  const technical = cookielessTransportProperties(properties, projectToken);
  if (eventName === "$web_vitals") {
    const vitals = sanitizeWebVitals(properties, currentOrigin);
    if (!vitals) return false;
    replaceProperties(properties, { ...technical, ...vitals });
    return true;
  }

  const currentUrl = eventPublicUrl(properties, currentOrigin);
  if (!currentUrl) return false;
  const referrer = typeof properties.$referrer === "string" ? properties.$referrer : undefined;
  const sanitized = {
    ...technical,
    $current_url: sanitizedPublicUrl(currentUrl),
    $host: currentUrl.host,
    $pathname: currentUrl.pathname,
    $referrer: sanitizedReferrer(referrer, currentOrigin),
    ...sanitizedCampaignProperties(properties, currentUrl),
    ...pageEngagementProperties(properties),
  };
  replaceProperties(properties, removeEmpty(sanitized));
  return true;
}

function sanitizeWebVitals(
  properties: Record<string, unknown>,
  currentOrigin: string,
): Record<string, unknown> | undefined {
  const currentUrl = eventPublicUrl(properties, currentOrigin);
  const sanitizedEvents: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!WEB_VITAL_EVENT_KEY.test(key)) continue;
    if (!isRecord(value)) return undefined;
    const nestedCurrentUrl = value.$current_url;
    if (typeof nestedCurrentUrl !== "string") return undefined;
    const nestedUrl = sameOriginPublicUrl(nestedCurrentUrl, currentOrigin);
    if (!nestedUrl) return undefined;

    const name = key.slice("$web_vitals_".length, -"_event".length);
    const metricValue = finiteNumber(value.value);
    if (value.name !== name || metricValue === undefined) return undefined;
    sanitizedEvents[key] = removeEmpty({
      name,
      value: metricValue,
      rating:
        typeof value.rating === "string" && WEB_VITAL_RATINGS.has(value.rating)
          ? value.rating
          : undefined,
      delta: finiteNumber(value.delta),
      navigationType:
        typeof value.navigationType === "string" &&
        WEB_VITAL_NAVIGATION_TYPES.has(value.navigationType)
          ? value.navigationType
          : undefined,
      $current_url: sanitizedPublicUrl(nestedUrl),
      timestamp: finiteNumber(value.timestamp),
    });
  }

  if (Object.keys(sanitizedEvents).length === 0) return undefined;
  const pageUrl = currentUrl ?? firstNestedVitalsUrl(sanitizedEvents, currentOrigin);
  if (!pageUrl) return undefined;
  return {
    $current_url: sanitizedPublicUrl(pageUrl),
    $host: pageUrl.host,
    $pathname: pageUrl.pathname,
    ...sanitizedEvents,
  };
}

function eventPublicUrl(
  properties: Record<string, unknown>,
  currentOrigin: string,
): URL | undefined {
  for (const value of [properties.$current_url, properties.$pathname]) {
    if (typeof value !== "string") continue;
    const url = sameOriginPublicUrl(value, currentOrigin);
    if (url) return url;
  }
  return undefined;
}

function sameOriginPublicUrl(value: string, currentOrigin: string): URL | undefined {
  try {
    const url = new URL(value, currentOrigin);
    if (url.origin !== currentOrigin || !isPublicTelemetryPath(url.pathname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function firstNestedVitalsUrl(
  events: Record<string, unknown>,
  currentOrigin: string,
): URL | undefined {
  for (const value of Object.values(events)) {
    if (!isRecord(value) || typeof value.$current_url !== "string") continue;
    const url = sameOriginPublicUrl(value.$current_url, currentOrigin);
    if (url) return url;
  }
  return undefined;
}

function sanitizedCampaignProperties(
  properties: Record<string, unknown>,
  currentUrl: URL,
): Record<string, string | undefined> {
  return Object.fromEntries(
    CAMPAIGN_KEYS.map((key) => {
      const propertyValue = properties[`$${key}`];
      return [
        `$${key}`,
        sanitizeCampaignValue(propertyValue) ??
          sanitizeCampaignValue(currentUrl.searchParams.get(key)),
      ];
    }),
  );
}

function sanitizeCampaignValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return CAMPAIGN_VALUE.test(trimmed) ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pageEngagementProperties(
  properties: Record<string, unknown>,
): Record<string, number> {
  const sanitized: Record<string, number> = {};
  for (const key of PAGE_ENGAGEMENT_PROPERTIES) {
    const value = properties[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    if (key.endsWith("_percentage") && value > 100) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function cookielessTransportProperties(
  properties: Record<string, unknown>,
  projectToken: string,
): Record<string, string | number | boolean> {
  return removeEmpty({
    token: properties.token === projectToken ? projectToken : undefined,
    distinct_id:
      properties.distinct_id === "$posthog_cookieless"
        ? "$posthog_cookieless"
        : undefined,
    $cookieless_mode: properties.$cookieless_mode === true ? true : undefined,
    $process_person_profile:
      properties.$process_person_profile === false ? false : undefined,
  });
}

function replaceProperties(
  target: Record<string, unknown>,
  sanitized: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, sanitized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
