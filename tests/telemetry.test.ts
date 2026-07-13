import { describe, expect, test } from "bun:test";

import {
  isPublicTelemetryPath,
  publicTelemetryProperties,
  sanitizePostHogProperties,
  sanitizePostHogWebVitalsProperties,
  sanitizedPublicUrl,
  sanitizedReferrer,
} from "@/lib/telemetry";

describe("public telemetry sanitization", () => {
  test("allows public marketing, docs, and comparison paths", () => {
    expect(isPublicTelemetryPath("/")).toBe(true);
    expect(isPublicTelemetryPath("/contact")).toBe(true);
    expect(isPublicTelemetryPath("/docs/self-hosted")).toBe(true);
    expect(isPublicTelemetryPath("/blog/best-ai-code-review-tools-2026")).toBe(true);
    expect(isPublicTelemetryPath("/vs/copilot")).toBe(true);
  });

  test("does not capture protected dashboard paths", () => {
    expect(isPublicTelemetryPath("/reports")).toBe(false);
    expect(isPublicTelemetryPath("/orgs/postil")).toBe(false);
    expect(publicTelemetryProperties("https://postil.dev/reports?token=abc")).toBeUndefined();
  });

  test("keeps campaign query params and drops arbitrary query params", () => {
    expect(
      sanitizedPublicUrl(
        "https://postil.dev/docs?utm_source=hn&secret=keep-out&ref=launch#section",
      ),
    ).toBe("https://postil.dev/docs?utm_source=hn&ref=launch");
  });

  test("sanitizes referrers without leaking arbitrary query strings", () => {
    expect(
      sanitizedReferrer(
        "https://google.com/search?q=private+query&utm_campaign=launch",
        "https://postil.dev",
      ),
    ).toBe("https://google.com/?utm_campaign=launch");
    expect(
      sanitizedReferrer(
        "https://postil.dev/docs/self-hosted?x=secret&utm_source=docs",
        "https://postil.dev",
      ),
    ).toBe("https://postil.dev/docs/self-hosted?utm_source=docs");
    expect(
      sanitizedReferrer(
        "https://postil.dev/orgs/private?x=secret&utm_campaign=confidential&ref=private",
        "https://postil.dev",
      ),
    ).toBeUndefined();
  });

  test("sanitizes PostHog automatic URL and referrer properties", () => {
    const properties = sanitizePostHogProperties(
      {
        $ip: "203.0.113.10",
        $current_url: "https://postil.dev/docs?utm_campaign=launch&secret=must_drop",
        $initial_current_url: "https://postil.dev/orgs/private?secret=must_drop",
        $referrer: "https://google.com/search?q=private&utm_source=search",
      },
      "https://postil.dev",
    );

    expect(properties.$ip).toBeUndefined();
    expect(properties.$current_url).toBe("https://postil.dev/docs?utm_campaign=launch");
    expect(properties.$initial_current_url).toBe("https://postil.dev/");
    expect(properties.$referrer).toBe("https://google.com/?utm_source=search");
    expect(JSON.stringify(properties)).not.toContain("must_drop");
    expect(JSON.stringify(properties)).not.toContain("private");
  });

  test("minimizes nested Web Vitals and rejects protected pages", () => {
    const properties: Record<string, unknown> = {
      $web_vitals_LCP_event: {
        name: "LCP",
        value: 1500,
        rating: "good",
        $current_url: "https://postil.dev/pricing?secret=drop&utm_source=docs",
        entries: [{ name: "private payload" }],
      },
    };
    expect(sanitizePostHogWebVitalsProperties(properties, "https://postil.dev")).toBe(true);
    expect(properties.$web_vitals_LCP_event).toEqual({
      name: "LCP",
      value: 1500,
      rating: "good",
      $current_url: "https://postil.dev/pricing?utm_source=docs",
    });
    expect(
      sanitizePostHogWebVitalsProperties(
        {
          $web_vitals_LCP_event: {
            name: "LCP",
            value: 1500,
            $current_url: "https://postil.dev/orgs/private?secret=drop",
          },
        },
        "https://postil.dev",
      ),
    ).toBe(false);
  });
});
