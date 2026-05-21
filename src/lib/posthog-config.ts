export const POSTHOG_BROWSER_HOST =
  process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";

export const POSTHOG_BROWSER_ORIGIN = new URL(POSTHOG_BROWSER_HOST).origin;
