import { describe, expect, mock, test } from "bun:test";

type CapturedEvent = {
  event: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
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
  test("captures public routes with strict cookieless privacy controls", async () => {
    const browser = installFakeBrowser(
      "https://postil.dev/docs?utm_source=launch&secret=drop",
      "https://google.com/search?q=private&utm_campaign=launch",
      {
        cookies: {
          ph_project_posthog: "legacy",
          postil_session: "keep",
        },
        localStorage: {
          ph_project_posthog: "legacy",
          postil_preference: "keep",
        },
        sessionStorage: {
          ph_project_primary_window_exists: "legacy",
          ph_project_window_id: "legacy-tab",
          postil_draft: "keep",
        },
      },
    );
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () =>
        Response.json({
          key: "public-project-token",
          apiHost: "https://eu.i.posthog.com",
          uiHost: "https://eu.posthog.com",
        }),
    });

    const { capturePublicPageview } = await import("@/instrumentation-client");
    expect(browser.cookies()).toEqual({ postil_session: "keep" });
    expect(browser.localStorage.entries()).toEqual({ postil_preference: "keep" });
    expect(browser.sessionStorage.entries()).toEqual({ postil_draft: "keep" });
    await capturePublicPageview(window.location.href, document.referrer);

    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]).toMatchObject({
      key: "public-project-token",
      config: {
        api_host: "https://eu.i.posthog.com",
        ui_host: "https://eu.posthog.com",
        cookieless_mode: "always",
        disable_persistence: true,
        person_profiles: "never",
        respect_dnt: true,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: true,
        disable_beacon: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_product_tours: true,
        disable_conversations: true,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        capture_exceptions: false,
        advanced_disable_flags: true,
        capture_performance: {
          web_vitals: true,
          network_timing: false,
          web_vitals_attribution: false,
        },
      },
    });
    expect(capturedEvents.map((event) => event.event)).toEqual(["$pageview"]);
    expect(capturedEvents[0]?.properties?.$current_url).toBe(
      "https://postil.dev/docs",
    );
    expect(capturedEvents[0]?.properties?.$utm_source).toBe("launch");
    expect(JSON.stringify(capturedEvents[0]?.properties)).not.toContain("secret");
    expect(JSON.stringify(capturedEvents[0]?.properties)).not.toContain("private");

    browser.navigate("/docs?secret=changed");
    await capturePublicPageview(window.location.href, document.referrer);
    browser.navigate("/docs?utm_source=other&secret=changed-again");
    await capturePublicPageview(window.location.href, document.referrer);
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0]?.properties?.$utm_source).toBe("launch");

    const queryOnlyPageleave = beforeSend?.({
      event: "$pageleave",
      properties: {
        $current_url: "https://postil.dev/docs?secret=changed-again",
        $pathname: "/docs",
        $prev_pageview_duration: 500,
      },
    });
    expect(queryOnlyPageleave?.properties).toMatchObject({
      $current_url: "https://postil.dev/docs",
      $pathname: "/docs",
      $prev_pageview_duration: 500,
    });
    const queryOnlyVitals = beforeSend?.({
      event: "$web_vitals",
      properties: {
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 1200,
          $current_url: "https://postil.dev/docs?secret=changed-again",
        },
      },
    });
    expect(queryOnlyVitals?.properties).toMatchObject({
      $current_url: "https://postil.dev/docs",
      $pathname: "/docs",
    });

    browser.navigate("/pricing?utm_campaign=summer&secret=drop");
    await capturePublicPageview(window.location.href, document.referrer);
    expect(capturedEvents).toHaveLength(2);
    expect(capturedEvents[1]?.properties?.$current_url).toBe(
      "https://postil.dev/pricing",
    );
    expect(capturedEvents[1]?.properties?.$utm_campaign).toBe("summer");

    browser.navigate("/dashboard?secret=drop");
    await capturePublicPageview(window.location.href, document.referrer);
    expect(capturedEvents).toHaveLength(2);

    expect(
      beforeSend?.({
        event: "$pageleave",
        properties: {
          $current_url: "https://postil.dev/pricing",
          $pathname: "/pricing",
          $prev_pageview_duration: 600,
        },
      }),
    ).toBeNull();
    const returnPageview = beforeSend?.({
      event: "$pageview",
      properties: {
        $current_url: "https://postil.dev/pricing",
        $pathname: "/pricing",
        $prev_pageview_pathname: "/pricing",
        $prev_pageview_duration: 600,
        $prev_pageview_max_scroll_percentage: 100,
      },
    });
    expect(returnPageview?.properties).toEqual({
      $current_url: "https://postil.dev/pricing",
      $host: "postil.dev",
      $pathname: "/pricing",
    });

    browser.navigate("/pricing?utm_campaign=summer&secret=drop");
    await capturePublicPageview(window.location.href, document.referrer);
    expect(capturedEvents).toHaveLength(3);

    const publicPageleave = beforeSend?.({
      event: "$pageleave",
      properties: {
        $current_url: "https://postil.dev/pricing?utm_campaign=summer&secret=drop",
        $pathname: "/pricing",
      },
    });
    expect(publicPageleave?.properties?.$current_url).toBe(
      "https://postil.dev/pricing",
    );
    expect(
      beforeSend?.({ event: "$pageleave", properties: { $pathname: "/dashboard" } }),
    ).toBeNull();
    expect(
      beforeSend?.({
        event: "$autocapture",
        properties: { $current_url: "https://postil.dev/docs" },
      }),
    ).toBeNull();

    const publicVitals = beforeSend?.({
      event: "$web_vitals",
      properties: {
        $current_url: "https://postil.dev/docs?secret=drop&utm_source=docs",
        $web_vitals_LCP_value: 1234,
        $web_vitals_LCP_event: {
          name: "LCP",
          value: 1234,
          rating: "good",
          delta: 1200,
          navigationType: "navigate",
          $current_url: "https://postil.dev/docs?secret=drop&utm_source=docs",
          timestamp: 10,
          id: "discard",
          entries: [{ name: "https://postil.dev/docs?secret=drop" }],
        },
      },
    });
    expect(publicVitals?.properties?.$current_url).toBe(
      "https://postil.dev/docs",
    );
    expect(publicVitals?.properties?.$web_vitals_LCP_event).toEqual({
      name: "LCP",
      value: 1234,
      rating: "good",
      delta: 1200,
      navigationType: "navigate",
      $current_url: "https://postil.dev/docs",
      timestamp: 10,
    });
    expect(JSON.stringify(publicVitals)).not.toContain("secret");
    const hostileAutomaticProperties = beforeSend?.({
      event: "$pageview",
      properties: {
        token: "public-project-token",
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
        $process_person_profile: false,
        $current_url:
          "https://postil.dev/docs?utm_source=release&gclid=click-id&secret=drop",
        $pathname: "/docs",
        $referrer: "https://example.com/path?query=private",
        $device_id: "persistent-id",
        $session_id: "session-id",
        $initial_current_url: "https://postil.dev/orgs/private",
        $utm_source: "release",
        $utm_medium: "x".repeat(65),
        gclid: "click-id",
      },
      $set: { email: "private@example.com" },
      $set_once: { $initial_current_url: "https://postil.dev/orgs/private" },
    });
    expect(hostileAutomaticProperties).toEqual({
      event: "$pageview",
      properties: {
        token: "public-project-token",
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
        $process_person_profile: false,
        $current_url: "https://postil.dev/docs",
        $host: "postil.dev",
        $pathname: "/docs",
        $referrer: "https://example.com/",
        $utm_source: "release",
      },
    });
    expect(
      beforeSend?.({
        event: "$web_vitals",
        properties: {
          $web_vitals_LCP_event: {
            name: "LCP",
            value: 1234,
            $current_url: "https://postil.dev/orgs/private?secret=drop",
          },
        },
      }),
    ).toBeNull();
  });
});

function installFakeBrowser(
  initialUrl: string,
  referrer: string,
  seed: {
    cookies?: Record<string, string>;
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
  } = {},
) {
  const location = new URL(initialUrl) as URL & { href: string };
  const cookieJar: Record<string, string> = { ...(seed.cookies ?? {}) };
  const document = {
    referrer,
    get cookie() {
      return Object.entries(cookieJar)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    set cookie(value: string) {
      const pair = value.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (value.includes("Max-Age=0")) delete cookieJar[name];
      else cookieJar[name] = cookieValue;
    },
  };
  const localStorage = fakeStorage(seed.localStorage);
  const sessionStorage = fakeStorage(seed.sessionStorage);
  const window = { location, localStorage, sessionStorage };

  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });

  return {
    navigate: (url: string | URL) => updateLocation(location, url),
    cookies: () => ({ ...cookieJar }),
    localStorage,
    sessionStorage,
  };
}

function fakeStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => values.delete(key),
    entries: () => Object.fromEntries(values),
  };
}

function updateLocation(location: URL & { href: string }, next: string | URL): void {
  const url = new URL(next.toString(), location.href);
  location.href = url.href;
}
