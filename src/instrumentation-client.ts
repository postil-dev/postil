import posthog from "posthog-js";

import {
  publicTelemetryProperties,
  sanitizePostHogEventProperties,
} from "@/lib/telemetry";
const ALLOWED_EVENTS = new Set(["$pageview", "$pageleave", "$web_vitals"]);

clearLegacyPostHogPersistence();

let bootPromise: Promise<boolean> | undefined;

interface PostHogConfig {
  key: string;
  apiHost: string;
  uiHost: string;
}

async function bootPostHog(): Promise<boolean> {
  const config = await runtimeConfig();
  if (!config) return false;
  posthog.init(config.key, {
    api_host: config.apiHost,
    ui_host: config.uiHost,
    defaults: "2026-05-30",
    cookieless_mode: "always",
    disable_persistence: true,
    person_profiles: "never",
    respect_dnt: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: true,
    disable_beacon: false,
    capture_performance: {
      web_vitals: true,
      network_timing: false,
      web_vitals_attribution: false,
    },
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    advanced_disable_flags: true,
    before_send: (event) => {
      if (!event || !ALLOWED_EVENTS.has(event.event) || !event.properties) return null;
      if (
        (event.event === "$pageview" || event.event === "$pageleave") &&
        !publicEventProperties(event.properties)
      ) {
        return null;
      }
      if (crossedProtectedRoute && event.event === "$pageleave") return null;
      if (crossedProtectedRoute && event.event === "$pageview") {
        removePropertyGroup(event.properties, "$prev_pageview_");
        crossedProtectedRoute = false;
      }
      delete event.$set;
      delete event.$set_once;
      if (
        !sanitizePostHogEventProperties(
          event.event as "$pageview" | "$pageleave" | "$web_vitals",
          event.properties,
          window.location.origin,
          config.key,
        )
      ) {
        return null;
      }
      return event;
    },
  });
  return true;
}

async function runtimeConfig(): Promise<PostHogConfig | undefined> {
  try {
    const response = await fetch("/api/analytics/posthog", { cache: "no-store" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<PostHogConfig>;
    if (
      typeof body.key !== "string" ||
      typeof body.apiHost !== "string" ||
      typeof body.uiHost !== "string"
    ) {
      return undefined;
    }
    return { key: body.key, apiHost: body.apiHost, uiHost: body.uiHost };
  } catch {
    return undefined;
  }
}

let lastCapturedUrl = "";
let crossedProtectedRoute = false;

export async function capturePublicPageview(
  currentUrl: string,
  referrer: string,
): Promise<void> {
  const properties = publicTelemetryProperties(currentUrl, referrer);
  if (!properties) {
    lastCapturedUrl = "";
    crossedProtectedRoute = true;
    return;
  }
  const publicPageUrl = properties.$current_url;
  if (typeof publicPageUrl !== "string" || publicPageUrl === lastCapturedUrl) return;
  bootPromise ??= bootPostHog();
  if (!(await bootPromise)) return;
  lastCapturedUrl = publicPageUrl;
  posthog.capture("$pageview", properties);
}

function clearLegacyPostHogPersistence(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const legacyKey = /^ph_.+_(?:posthog|primary_window_exists|window_id)(?:_.+)?$/;
  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[storageName];
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key && legacyKey.test(key)) storage.removeItem(key);
      }
    } catch {
      // Storage can be unavailable in hardened browser contexts.
    }
  }

  try {
    const hostname = window.location.hostname;
    const hostParts = hostname.split(".");
    const cookieDomains = new Set([`.${hostname}`]);
    for (let index = 1; index < hostParts.length - 1; index += 1) {
      cookieDomains.add(`.${hostParts.slice(index).join(".")}`);
    }
    for (const cookie of document.cookie.split(";")) {
      const name = cookie.split("=", 1)[0]?.trim();
      if (!name || !legacyKey.test(name)) continue;
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
      for (const domain of cookieDomains) {
        document.cookie = `${name}=; Path=/; Domain=${domain}; Max-Age=0; SameSite=Lax`;
      }
    }
  } catch {
    // Cookie access can be unavailable in hardened browser contexts.
  }
}

function publicEventProperties(properties: Record<string, unknown>): boolean {
  const location = [properties.$current_url, properties.$pathname].find(
    (value): value is string => typeof value === "string",
  );
  return Boolean(location && isPublicTelemetryLocation(location));
}

function removePropertyGroup(properties: Record<string, unknown>, prefix: string): void {
  for (const key of Object.keys(properties)) {
    if (key.startsWith(prefix)) delete properties[key];
  }
}

function isPublicTelemetryLocation(location: string): boolean {
  try {
    return Boolean(publicTelemetryProperties(new URL(location, window.location.origin)));
  } catch {
    return false;
  }
}
