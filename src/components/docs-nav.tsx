"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const DOCS_NAV = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/config", label: "Configuration (.postil.yaml)" },
  { href: "/docs/cli", label: "CLI reference" },
  { href: "/docs/exit-codes", label: "Exit codes" },
  { href: "/docs/gate", label: "The gate and branch protection" },
  { href: "/docs/plan", label: "postil plan (dry-run)" },
  { href: "/docs/envelope", label: "Envelope schema" },
  { href: "/docs/content-policy", label: "Content policy" },
  { href: "/docs/forges", label: "Forges (GitHub, GitLab, Bitbucket, Azure)" },
  { href: "/docs/self-hosted", label: "Self-hosted" },
  { href: "/docs/self-hosted#operations", label: "Self-hosted: Operations" },
  { href: "/docs/models", label: "Models and local inference" },
] as const;

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="mt-4 space-y-1.5 text-sm">
      {DOCS_NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "block rounded border-l-2 border-rust bg-stone/60 px-2 py-1 font-medium text-charcoal"
                : "block rounded px-2 py-1 text-charcoal/70 hover:bg-stone hover:text-charcoal"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
