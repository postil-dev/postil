import { describe, expect, test } from "bun:test";

import {
  isPublicTelemetryPath,
  publicTelemetryProperties,
  sanitizePostHogEventProperties,
  sanitizedPublicUrl,
  sanitizedReferrer,
} from "@/lib/telemetry";

describe("public telemetry sanitization", () => {
  test("allows exact public marketing, docs, and comparison paths", () => {
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

  test("rejects unknown and oversized public-looking paths", () => {
    for (const path of [
      "/docs/account-reset/secret-token-123",
      "/vs/nonexistent-9a44acb7-43f9-4219-903f-f2fa7f2482c7",
      `/blog/${"x".repeat(1_000)}`,
    ]) {
      expect(isPublicTelemetryPath(path)).toBe(false);
      expect(publicTelemetryProperties(`https://postil.dev${path}`)).toBeUndefined();
      const properties: Record<string, unknown> = {
        $current_url: `https://postil.dev${path}`,
      };
      expect(
        sanitizePostHogEventProperties(
          "$pageview",
          properties,
          "https://postil.dev",
          "phc_test",
        ),
      ).toBe(false);
    }
  });

  test("removes every query parameter from captured URLs", () => {
    expect(
      sanitizedPublicUrl(
        "https://postil.dev/docs?utm_source=hn&secret=keep-out&ref=launch#section",
      ),
    ).toBe("https://postil.dev/docs");
  });

  test("reduces referrers to their origin", () => {
    expect(
      sanitizedReferrer(
        "https://google.com/search?q=private+query&utm_campaign=launch",
        "https://postil.dev",
      ),
    ).toBe("https://google.com/");
    expect(
      sanitizedReferrer(
        "https://postil.dev/docs/self-hosted?x=secret&utm_source=docs",
        "https://postil.dev",
      ),
    ).toBe("https://postil.dev/");
    expect(
      sanitizedReferrer(
        "https://postil.dev/orgs/private?x=secret&utm_campaign=confidential&ref=private",
        "https://postil.dev",
      ),
    ).toBe("https://postil.dev/");
  });

  test("allowlists PostHog properties and bounds campaign values", () => {
    const properties: Record<string, unknown> = {
      token: "phc_test",
      distinct_id: "$posthog_cookieless",
      $cookieless_mode: true,
      $process_person_profile: false,
      $ip: "203.0.113.10",
      $device_id: "persistent-id",
      $session_id: "session-id",
      $current_url:
        "https://postil.dev/docs?utm_source=Docs+Launch&gclid=click-id&secret=must-drop",
      $pathname: "/orgs/private",
      $referrer: "https://google.com/search?q=private&utm_source=search",
      $utm_source: "Docs Launch",
      $utm_medium: "x".repeat(65),
      $utm_campaign: "release<script>",
      gclid: "click-id",
      unexpected: "private payload",
    };

    expect(
      sanitizePostHogEventProperties(
        "$pageview",
        properties,
        "https://postil.dev",
        "phc_test",
      ),
    ).toBe(true);
    expect(properties).toEqual({
      token: "phc_test",
      distinct_id: "$posthog_cookieless",
      $cookieless_mode: true,
      $process_person_profile: false,
      $current_url: "https://postil.dev/docs",
      $host: "postil.dev",
      $pathname: "/docs",
      $referrer: "https://google.com/",
      $utm_source: "Docs Launch",
    });
  });

  test("retains bounded pageleave engagement only", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://postil.dev/pricing?secret=drop",
      $pathname: "/pricing",
      $prev_pageview_duration: 500,
      $prev_pageview_max_scroll_percentage: 74,
      $prev_pageview_last_scroll_percentage: 101,
      $prev_pageview_max_scroll: Number.POSITIVE_INFINITY,
      arbitrary: "drop",
    };

    expect(
      sanitizePostHogEventProperties(
        "$pageleave",
        properties,
        "https://postil.dev",
        "phc_test",
      ),
    ).toBe(true);
    expect(properties).toEqual({
      $current_url: "https://postil.dev/pricing",
      $host: "postil.dev",
      $pathname: "/pricing",
      $prev_pageview_duration: 500,
      $prev_pageview_max_scroll_percentage: 74,
    });
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
    expect(
      sanitizePostHogEventProperties(
        "$web_vitals",
        properties,
        "https://postil.dev",
        "phc_test",
      ),
    ).toBe(true);
    expect(properties).toEqual({
      $current_url: "https://postil.dev/pricing",
      $host: "postil.dev",
      $pathname: "/pricing",
      $web_vitals_LCP_event: {
        name: "LCP",
        value: 1500,
        rating: "good",
        $current_url: "https://postil.dev/pricing",
      },
    });
    expect(
      sanitizePostHogEventProperties(
        "$web_vitals",
        {
          $web_vitals_LCP_event: {
            name: "LCP",
            value: 1500,
            $current_url: "https://postil.dev/orgs/private?secret=drop",
          },
        },
        "https://postil.dev",
        "phc_test",
      ),
    ).toBe(false);
  });

  test("rejects malformed Web Vitals and drops unbounded metric metadata", () => {
    const unbounded: Record<string, unknown> = {
      $web_vitals_INP_event: {
        name: "INP",
        value: 240,
        rating: "x".repeat(1_000),
        navigationType: "private-navigation-label",
        $current_url: "https://postil.dev/docs?secret=drop",
      },
    };
    expect(
      sanitizePostHogEventProperties(
        "$web_vitals",
        unbounded,
        "https://postil.dev",
        "phc_test",
      ),
    ).toBe(true);
    expect(unbounded.$web_vitals_INP_event).toEqual({
      name: "INP",
      value: 240,
      $current_url: "https://postil.dev/docs",
    });

    expect(
      sanitizePostHogEventProperties(
        "$web_vitals",
        {
          $web_vitals_CLS_event: {
            name: "LCP",
            value: 0.1,
            $current_url: "https://postil.dev/docs",
          },
        },
        "https://postil.dev",
        "phc_test",
      ),
    ).toBe(false);
  });
});
