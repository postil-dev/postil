import posthog from "posthog-js";

import { publicTelemetryProperties } from "@/lib/telemetry";

const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";

if (token) {
  posthog.init(token, {
    api_host: host,
    defaults: "2026-05-30",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    person_profiles: "identified_only",
    before_send: (event) => {
      if (!event?.properties) return event;
      delete event.properties.$ip;
      return event;
    },
  });
  installPageviewCapture();
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
