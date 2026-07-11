import posthog from "posthog-js";

import { publicTelemetryProperties, sanitizePostHogProperties } from "@/lib/telemetry";

const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";
const SESSION_ATTRIBUTION_PROPERTIES = new Set([
  "$current_url",
  "$host",
  "$pathname",
  "$referrer",
  "$referring_domain",
  "$search_engine",
  "ph_keyword",
  "gad_source",
  "mc_cid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "igshid",
  "ttclid",
  "rdt_cid",
  "epik",
  "qclid",
  "sccid",
  "irclid",
  "_kx",
]);

void bootPostHog();

async function bootPostHog(): Promise<void> {
  const config = token ? { key: token, host } : await runtimeConfig();
  if (!config?.key) return;
  posthog.init(config.key, {
    api_host: config.host,
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: true,
    disable_session_recording: true,
    person_profiles: "identified_only",
    before_send: (event) => {
      if (
        (event?.event === "$pageview" || event?.event === "$pageleave") &&
        !publicTelemetryProperties(window.location.href)
      ) {
        return null;
      }
      if (!event?.properties) return event;
      removeProtectedPropertyGroup(
        event.properties,
        "$prev_pageview_",
        "$prev_pageview_pathname",
      );
      removeProtectedPropertyGroup(
        event.properties,
        "$session_entry_",
        "$session_entry_pathname",
        "$session_entry_url",
      );
      removeProtectedPropertyGroup(
        event.properties,
        "$initial_",
        "$initial_pathname",
        "$initial_current_url",
      );
      sanitizePostHogProperties(event.properties, window.location.origin);
      if (event.$set_once) {
        removeProtectedPropertyGroup(
          event.$set_once,
          "$initial_",
          "$initial_pathname",
          "$initial_current_url",
        );
        removeProtectedSessionAttribution(event.$set_once);
        sanitizePostHogProperties(event.$set_once, window.location.origin);
      }
      return event;
    },
  });
  installPageviewCapture();
}

interface PostHogConfig {
  key: string;
  host: string;
}

async function runtimeConfig(): Promise<PostHogConfig | undefined> {
  try {
    const response = await fetch("/api/analytics/posthog", { cache: "force-cache" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<PostHogConfig>;
    if (typeof body.key !== "string" || typeof body.host !== "string") return undefined;
    return { key: body.key, host: body.host };
  } catch {
    return undefined;
  }
}

let lastCapturedUrl = "";

function installPageviewCapture(): void {
  if (typeof window === "undefined") return;
  queueMicrotask(capturePageview);
  window.addEventListener("popstate", capturePageview);
  const pushState = window.history.pushState;
  const replaceState = window.history.replaceState;
  window.history.pushState = function pushStateWithCapture(...args) {
    const value = pushState.apply(this, args);
    queueMicrotask(capturePageview);
    return value;
  };
  window.history.replaceState = function replaceStateWithCapture(...args) {
    const value = replaceState.apply(this, args);
    queueMicrotask(capturePageview);
    return value;
  };
}

function capturePageview(): void {
  const currentUrl = window.location.href;
  if (currentUrl === lastCapturedUrl) return;
  lastCapturedUrl = currentUrl;
  const properties = publicTelemetryProperties(currentUrl, document.referrer);
  posthog.capture("$pageview", properties);
  if (!properties) return;
  posthog.capture("postil_pageview", properties);
}

function removeProtectedPropertyGroup(
  properties: Record<string, unknown>,
  prefix: string,
  ...locationKeys: string[]
): void {
  const location = locationKeys
    .map((key) => properties[key])
    .find((value): value is string => typeof value === "string");
  if (!location) return;
  if (isPublicTelemetryLocation(location)) return;
  for (const key of Object.keys(properties)) {
    if (key.startsWith(prefix)) delete properties[key];
  }
}

function removeProtectedSessionAttribution(properties: Record<string, unknown>): void {
  const location = [properties.$pathname, properties.$current_url].find(
    (value): value is string => typeof value === "string",
  );
  if (!location || isPublicTelemetryLocation(location)) return;
  for (const key of Object.keys(properties)) {
    if (SESSION_ATTRIBUTION_PROPERTIES.has(key) || key.startsWith("utm_")) {
      delete properties[key];
    }
  }
}

function isPublicTelemetryLocation(location: string): boolean {
  try {
    return Boolean(publicTelemetryProperties(new URL(location, window.location.origin)));
  } catch {
    return false;
  }
}
