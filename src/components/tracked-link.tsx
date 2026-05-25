"use client";

import Link from "next/link";
import posthog from "posthog-js";
import type { ReactNode } from "react";

export function TrackedLink({
  href,
  cta,
  className,
  children,
}: {
  href: string;
  cta: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={className}
      onClick={() => {
        posthog.capture("cta_click", { cta, href });
        if (cta === "Install CLI") {
          posthog.capture("install_redirect_started");
        }
      }}
    >
      {children}
    </Link>
  );
}
