"use client";

import { usePathname } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";

function PostHogPageView() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname) {
      posthog.capture("$pageview", {
        $current_url: window.location.href,
      });
    }
  }, [pathname]);

  return null;
}

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com";
    if (!key) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[posthog] NEXT_PUBLIC_POSTHOG_KEY is not set; analytics disabled");
      }
      return;
    }

    posthog.init(key, {
      api_host: host,
      person_profiles: "always",
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      mask_all_element_attributes: true,
      mask_all_text: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "[data-ph-no-capture]",
      },
    });
  }, []);

  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </PHProvider>
  );
}
