"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { capturePublicPageview } from "@/instrumentation-client";

export function PostHogPageview() {
  const pathname = usePathname();

  useEffect(() => {
    void capturePublicPageview(window.location.href, document.referrer);
  }, [pathname]);

  return null;
}
