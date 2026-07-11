import { describe, expect, mock, test } from "bun:test";

type CapturedEvent = {
  event: string;
  properties?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
  options?: Record<string, unknown>;
};

const capturedEvents: CapturedEvent[] = [];
const initCalls: Array<{ key: string; config: Record<string, unknown> }> = [];
let beforeSend: ((event: CapturedEvent) => CapturedEvent | null) | undefined;

mock.module("posthog-js", () => ({
  default: {
    init: (key: string, config: Record<string, unknown>) => {
      initCalls.push({ key, config });
      beforeSend = config.before_send as typeof beforeSend;
    },
    capture: (
      event: string,
      properties?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      const capturedEvent = beforeSend?.({ event, properties, options });
      if (capturedEvent) capturedEvents.push(capturedEvent);
      return { uuid: crypto.randomUUID(), event, properties: properties ?? {} };
    },
  },
}));

describe("browser PostHog instrumentation", () => {
  test("emits standard pageviews from the existing SPA route hooks", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_project_token";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    const browser = installFakeBrowser(
      "https://postil.dev/docs?utm_source=launch&secret=drop",
      "https://google.com/search?q=private&utm_campaign=launch",
    );

    await import("@/instrumentation-client");
    await Promise.resolve();

    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]?.config).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: true,
      disable_session_recording: true,
    });
    expect(capturedEvents.map((event) => event.event)).toEqual(["$pageview", "postil_pageview"]);
    expect(capturedEvents[0]?.properties?.$current_url).toBe(
      "https://postil.dev/docs?utm_source=launch",
    );
    expect(JSON.stringify(capturedEvents[0]?.properties)).not.toContain("secret");
    expect(JSON.stringify(capturedEvents[0]?.properties)).not.toContain("private");

    browser.history.pushState(null, "", "/pricing?utm_campaign=summer&secret=drop");
    await Promise.resolve();

    expect(capturedEvents.map((event) => event.event)).toEqual([
      "$pageview",
      "postil_pageview",
      "$pageview",
      "postil_pageview",
    ]);
    expect(capturedEvents[2]?.properties?.$current_url).toBe(
      "https://postil.dev/pricing?utm_campaign=summer",
    );

    const publicPageleave = beforeSend?.({
      event: "$pageleave",
      properties: {
        $current_url: "https://postil.dev/pricing?utm_campaign=summer&secret=drop",
        $pathname: "/pricing",
      },
    });
    expect(publicPageleave?.properties?.$current_url).toBe(
      "https://postil.dev/pricing?utm_campaign=summer",
    );

    browser.history.replaceState(null, "", "/dashboard?secret=drop");
    await Promise.resolve();

    expect(capturedEvents.map((event) => event.event)).toEqual([
      "$pageview",
      "postil_pageview",
      "$pageview",
      "postil_pageview",
    ]);
    expect(
      beforeSend?.({ event: "$pageleave", properties: { $pathname: "/dashboard" } }),
    ).toBeNull();

    browser.navigate("/docs?utm_source=return&secret=drop");
    browser.dispatchWindowEvent("popstate");

    expect(capturedEvents.map((event) => event.event)).toEqual([
      "$pageview",
      "postil_pageview",
      "$pageview",
      "postil_pageview",
      "$pageview",
      "postil_pageview",
    ]);
    expect(capturedEvents[4]?.properties?.$current_url).toBe(
      "https://postil.dev/docs?utm_source=return",
    );

    const resumedPublicPageview = beforeSend?.({
      event: "$pageview",
      properties: {
        $current_url: "https://postil.dev/docs?utm_source=return",
        $pathname: "/docs",
        $prev_pageview_id: "private-pageview-id",
        $prev_pageview_pathname: "/dashboard",
        $prev_pageview_duration: 120,
        $session_entry_pathname: "/orgs/private-organization",
        $session_entry_url:
          "https://postil.dev/orgs/private-organization?utm_source=private-campaign",
        $session_entry_utm_source: "private-campaign",
      },
      $set_once: {
        $initial_pathname: "/reports/private-report",
        $initial_current_url: "https://postil.dev/reports/private-report?utm_term=private",
        $initial_utm_term: "private",
        $pathname: "/orgs/private-organization",
        $current_url:
          "https://postil.dev/orgs/private-organization?utm_source=private-campaign",
        utm_source: "private-campaign",
        account_tier: "paid",
      },
    });
    expect(resumedPublicPageview?.properties).not.toHaveProperty("$prev_pageview_id");
    expect(resumedPublicPageview?.properties).not.toHaveProperty("$prev_pageview_pathname");
    expect(resumedPublicPageview?.properties).not.toHaveProperty("$prev_pageview_duration");
    expect(resumedPublicPageview?.properties).not.toHaveProperty("$session_entry_pathname");
    expect(resumedPublicPageview?.properties).not.toHaveProperty("$session_entry_url");
    expect(resumedPublicPageview?.properties).not.toHaveProperty("$session_entry_utm_source");
    expect(resumedPublicPageview?.$set_once).not.toHaveProperty("$initial_pathname");
    expect(resumedPublicPageview?.$set_once).not.toHaveProperty("$initial_current_url");
    expect(resumedPublicPageview?.$set_once).not.toHaveProperty("$initial_utm_term");
    expect(resumedPublicPageview?.$set_once).not.toHaveProperty("$pathname");
    expect(resumedPublicPageview?.$set_once).not.toHaveProperty("$current_url");
    expect(resumedPublicPageview?.$set_once).not.toHaveProperty("utm_source");
    expect(resumedPublicPageview?.$set_once?.account_tier).toBe("paid");
  });
});

function installFakeBrowser(initialUrl: string, referrer: string) {
  const windowListeners = new Map<string, Array<() => void>>();
  const location = new URL(initialUrl) as URL & { href: string };
  const document = {
    referrer,
  };
  const history = {
    pushState: (_state: unknown, _title: string, url?: string | URL | null) => {
      if (url) updateLocation(location, url);
    },
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
      if (url) updateLocation(location, url);
    },
  };
  const window = {
    location,
    history,
    addEventListener: (type: string, listener: () => void) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
  };

  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });

  return {
    history,
    navigate: (url: string | URL) => updateLocation(location, url),
    dispatchWindowEvent: (type: string) => {
      for (const listener of windowListeners.get(type) ?? []) listener();
    },
  };
}

function updateLocation(location: URL & { href: string }, next: string | URL): void {
  const url = new URL(next.toString(), location.href);
  location.href = url.href;
}
