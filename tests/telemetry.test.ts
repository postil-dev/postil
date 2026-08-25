import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  isPublicTelemetryPath,
  publicTelemetryProperties,
  sanitizePostHogEventProperties,
  sanitizedPublicUrl,
  sanitizedReferrer,
} from "@/lib/telemetry";

const SESSION_ID = "5d57d1aa-dd90-4d77-a21d-a8d3a25e6417";

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

  test("rejects unknown public-looking paths", () => {
    for (const path of [
      "/docs/account-reset/secret-token-123",
      "/vs/nonexistent-9a44acb7-43f9-4219-903f-f2fa7f2482c7",
      `/blog/${"x".repeat(1_000)}`,
    ]) {
      expect(isPublicTelemetryPath(path)).toBe(false);
      expect(publicTelemetryProperties(`https://postil.dev${path}`)).toBeUndefined();
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

  test("allowlists automatic properties and bounds campaign labels", () => {
    const properties: Record<string, unknown> = {
      token: "phc_test",
      distinct_id: "$posthog_cookieless",
      $cookieless_mode: true,
      $process_person_profile: false,
      $ip: "203.0.113.10",
      $device_id: "persistent-id",
      $session_id: "session-id",
      $current_url: "https://postil.dev/docs?utm_source=Docs+Launch&secret=drop",
      $pathname: "/orgs/private",
      $referrer: "https://google.com/search?q=private",
      $utm_source: "Docs Launch",
      $utm_medium: "x".repeat(65),
      $utm_campaign: "release<script>",
      $raw_user_agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/139.0.0.0",
      $screen_width: 2560,
      $screen_height: 1440,
      $viewport_width: 1280,
      $viewport_height: 720,
      $timezone: "Atlantic/Reykjavik",
      $timezone_offset: 0,
      $browser_language: "en-GB",
      $browser_language_prefix: "en",
      $initialization_time: 1787001374,
      $is_identified: false,
      $config_defaults: "2026-05-30",
      $lib_custom_api_host: "https://postil.dev/relay",
      $sdk_debug_retry_queue_size: 0,
      $lib_rate_limit_remaining_tokens: 99,
      unexpected: "private payload",
    };

    expect(
      sanitizePostHogEventProperties(
        "$pageview",
        properties,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);
    expect(properties).toEqual({
      token: "phc_test",
      distinct_id: "$posthog_cookieless",
      $cookieless_mode: true,
      $process_person_profile: false,
      $session_id: SESSION_ID,
      $raw_user_agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/139.0.0.0",
      $current_url: "https://postil.dev/docs",
      $host: "postil.dev",
      $pathname: "/docs",
      $referrer: "https://google.com/",
      $utm_source: "Docs Launch",
    });
  });

  test("preserves the validated Web Analytics context properties", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://postil.dev/docs",
      $pathname: "/docs",
      $lib: "web",
      $lib_version: "1.396.2",
      $insert_id: "jpzmsl07yq9r5sk8",
      $time: 1_787_001_374.548,
      $pageview_id: "0198f0f3-6a52-7f4b-9c31-1b2c3d4e5f60",
      $referring_domain: "news.ycombinator.com",
      $device_type: "Desktop",
      $browser: "Chrome",
      $browser_version: 139,
      $os: "Linux",
      $os_version: "10.15.7",
      $prev_pageview_pathname: "/pricing",
    };

    expect(
      sanitizePostHogEventProperties(
        "$pageview",
        properties,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);
    expect(properties).toEqual({
      $session_id: SESSION_ID,
      $current_url: "https://postil.dev/docs",
      $host: "postil.dev",
      $pathname: "/docs",
      $lib: "web",
      $lib_version: "1.396.2",
      $insert_id: "jpzmsl07yq9r5sk8",
      $time: 1_787_001_374.548,
      $pageview_id: "0198f0f3-6a52-7f4b-9c31-1b2c3d4e5f60",
      $referring_domain: "news.ycombinator.com",
      $device_type: "Desktop",
      $browser: "Chrome",
      $browser_version: 139,
      $os: "Linux",
      $os_version: "10.15.7",
      $prev_pageview_pathname: "/pricing",
    });
  });

  test("keeps direct traffic labelled without inventing a referrer", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://postil.dev/docs",
      $referrer: "$direct",
      $referring_domain: "$direct",
    };
    expect(
      sanitizePostHogEventProperties(
        "$pageview",
        properties,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);
    expect(properties.$referring_domain).toBe("$direct");
    expect(properties.$referrer).toBeUndefined();
  });

  test("preserves a string browser version without coercing it", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://postil.dev/docs",
      $browser_version: "139.0.1",
    };
    sanitizePostHogEventProperties(
      "$pageview",
      properties,
      "https://postil.dev",
      "phc_test",
      SESSION_ID,
    );
    expect(properties.$browser_version).toBe("139.0.1");
  });

  test("drops hostile context values instead of forwarding them", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://postil.dev/docs",
      $lib: "python",
      $lib_version: "1.396.2-beta",
      $insert_id: "x".repeat(65),
      $time: -1,
      $pageview_id: "not-a-uuid",
      $referring_domain: "evil.com/path?q=1",
      $device_type: "Watch",
      $browser: "<script>",
      $browser_version: "139.0.1.2.3",
      $os: "Linux; rv:109.0",
      $os_version: "10.15.7 (Build 19H2026 for user@example.com)",
      $prev_pageview_pathname: "/orgs/acme-corp",
    };

    expect(
      sanitizePostHogEventProperties(
        "$pageview",
        properties,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);
    expect(properties).toEqual({
      $session_id: SESSION_ID,
      $current_url: "https://postil.dev/docs",
      $host: "postil.dev",
      $pathname: "/docs",
    });
  });

  test("rejects referring domains carrying anything but a hostname", () => {
    for (const referringDomain of [
      "evil.com/path?q=1",
      "evil.com:8080",
      "https://evil.com",
      "evil com",
      "-evil.com",
      `${"a".repeat(254)}.com`,
      "$referrer",
    ]) {
      const properties: Record<string, unknown> = {
        $current_url: "https://postil.dev/docs",
        $referring_domain: referringDomain,
      };
      sanitizePostHogEventProperties(
        "$pageview",
        properties,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      );
      expect(properties.$referring_domain).toBeUndefined();
    }
  });

  test("applies the context allowlist to pageleave and Web Vitals events", () => {
    const context = {
      $lib: "web",
      $lib_version: "1.396.2",
      $device_type: "Mobile",
      $browser: "Chrome",
      $browser_version: 139,
      $os: "Linux",
      $raw_user_agent: "Mozilla/5.0 (X11; Linux x86_64)",
      $prev_pageview_pathname: "/orgs/acme-corp",
    };

    const pageleave: Record<string, unknown> = {
      $current_url: "https://postil.dev/pricing",
      ...context,
    };
    expect(
      sanitizePostHogEventProperties(
        "$pageleave",
        pageleave,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);

    const vitals: Record<string, unknown> = {
      $current_url: "https://postil.dev/pricing",
      $web_vitals_LCP_event: {
        name: "LCP",
        value: 1500,
        $current_url: "https://postil.dev/pricing",
      },
      ...context,
    };
    expect(
      sanitizePostHogEventProperties(
        "$web_vitals",
        vitals,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);

    for (const sanitized of [pageleave, vitals]) {
      expect(sanitized.$lib).toBe("web");
      expect(sanitized.$lib_version).toBe("1.396.2");
      expect(sanitized.$device_type).toBe("Mobile");
      expect(sanitized.$browser).toBe("Chrome");
      expect(sanitized.$browser_version).toBe(139);
      expect(sanitized.$os).toBe("Linux");
      expect(sanitized.$raw_user_agent).toBe("Mozilla/5.0 (X11; Linux x86_64)");
      expect(sanitized.$prev_pageview_pathname).toBeUndefined();
    }
  });

  test("reports the user agent cookieless identity hashing requires", () => {
    // Cookieless events without $raw_user_agent are discarded on arrival, so
    // every browser event type has to carry it or none of them are recorded.
    const userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    for (const event of ["$pageview", "$pageleave"] as const) {
      const properties: Record<string, unknown> = {
        $current_url: "https://postil.dev/pricing",
        $raw_user_agent: userAgent,
      };
      expect(
        sanitizePostHogEventProperties(
          event,
          properties,
          "https://postil.dev",
          "phc_test",
          SESSION_ID,
        ),
      ).toBe(true);
      expect(properties.$raw_user_agent).toBe(userAgent);
    }

    const vitals: Record<string, unknown> = {
      $current_url: "https://postil.dev/pricing",
      $raw_user_agent: userAgent,
      $web_vitals_CLS_event: {
        name: "CLS",
        value: 0.02,
        $current_url: "https://postil.dev/pricing",
      },
    };
    expect(
      sanitizePostHogEventProperties(
        "$web_vitals",
        vitals,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);
    expect(vitals.$raw_user_agent).toBe(userAgent);
  });

  test("rejects user agents outside the expected shape", () => {
    for (const value of [
      "",
      "x".repeat(1_025),
      "Mozilla/5.0\nX-Injected: header",
      "Mozilla/5.0\t(X11; Linux x86_64)",
      "Mozilla/5.0 (X11; Linux x86_64) é",
      42,
      { toString: () => "Mozilla/5.0" },
    ]) {
      const properties: Record<string, unknown> = {
        $current_url: "https://postil.dev/pricing",
        $raw_user_agent: value,
      };
      expect(
        sanitizePostHogEventProperties(
          "$pageview",
          properties,
          "https://postil.dev",
          "phc_test",
          SESSION_ID,
        ),
      ).toBe(true);
      expect(properties.$raw_user_agent).toBeUndefined();
    }
  });

  test("retains bounded pageleave engagement only", () => {
    const properties: Record<string, unknown> = {
      $current_url: "https://postil.dev/pricing?secret=drop",
      $pathname: "/pricing",
      $prev_pageview_duration: 500,
      $prev_pageview_max_scroll_percentage: 74,
      $prev_pageview_max_content_percentage: 62,
      $prev_pageview_max_content: 1840,
      $prev_pageview_last_scroll_percentage: 101,
      $prev_pageview_last_content_percentage: 101,
      $prev_pageview_max_scroll: Number.POSITIVE_INFINITY,
      arbitrary: "drop",
    };

    expect(
      sanitizePostHogEventProperties(
        "$pageleave",
        properties,
        "https://postil.dev",
        "phc_test",
        SESSION_ID,
      ),
    ).toBe(true);
    expect(properties).toEqual({
      $session_id: SESSION_ID,
      $current_url: "https://postil.dev/pricing",
      $host: "postil.dev",
      $pathname: "/pricing",
      $prev_pageview_duration: 500,
      $prev_pageview_max_scroll_percentage: 74,
      $prev_pageview_max_content_percentage: 62,
      $prev_pageview_max_content: 1840,
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
        SESSION_ID,
      ),
    ).toBe(true);
    expect(properties).toEqual({
      $session_id: SESSION_ID,
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
        SESSION_ID,
      ),
    ).toBe(false);
  });
});

describe("public telemetry path coverage", () => {
  test("every public route in the app tree is capturable", () => {
    const routes = staticAppRoutes();
    // Guard the enumeration itself: a broken walk would pass this test vacuously.
    expect(routes).toContain("/");
    expect(routes).toContain("/docs/forges/github");
    expect(routes.filter((route) => route.includes("["))).toEqual([]);

    const uncovered = routes.filter(
      (route) => !PROTECTED_ROUTE.test(route) && !isPublicTelemetryPath(route),
    );
    const report =
      uncovered.length === 0
        ? ""
        : `Add to PUBLIC_EXACT_PATHS in src/lib/telemetry.ts:\n${uncovered
            .map((route) => `  "${route}",`)
            .join("\n")}`;
    expect(report).toBe("");
  });
});

const PROTECTED_ROUTE = /^\/(?:orgs\/|operator|login|reports|verify|cli\/)/;

/** Every non-dynamic route the app renders, as the browser requests it. */
function staticAppRoutes(): string[] {
  return pageDirectories("src/app")
    .flatMap((directory) => {
      const segments = directory
        .split("/")
        .slice(2)
        .filter((segment) => !/^\(.*\)$/.test(segment));
      if (segments.some((segment) => segment.includes("["))) return [];
      return [`/${segments.join("/")}`];
    })
    .sort();
}

function pageDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return pageDirectories(path);
    return entry.isFile() && entry.name === "page.tsx" ? [root] : [];
  });
}
