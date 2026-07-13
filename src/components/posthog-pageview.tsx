"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { capturePublicPageview } from "@/instrumentation-client";

export function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  useEffect(() => {
    void capturePublicPageview(window.location.href, document.referrer);
  }, [pathname, query]);

  return null;
}
