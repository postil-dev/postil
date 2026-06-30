import posthog from "posthog-js";

import { publicTelemetryProperties, sanitizePostHogProperties } from "@/lib/telemetry";

const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";

void bootPostHog();

async function bootPostHog(): Promise<void> {
  const config = token ? { key: token, host } : await runtimeConfig();
  if (!config?.key) return;
  posthog.init(config.key, {
    api_host: config.host,
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
    before_send: (event) => {
      if (!event?.properties) return event;
      sanitizePostHogProperties(event.properties, window.location.origin);
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
  if (!properties) return;
  posthog.capture("postil_pageview", properties);
}
