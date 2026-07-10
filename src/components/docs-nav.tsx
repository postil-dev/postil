"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type DocsNavItem = {
  href: string;
  label: string;
  children?: readonly DocsNavItem[];
};

export const DOCS_NAV: readonly DocsNavItem[] = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/config", label: "Configuration (.postil.yaml)" },
  { href: "/docs/cli", label: "CLI reference" },
  { href: "/docs/exit-codes", label: "Exit codes" },
  { href: "/docs/gate", label: "The gate and branch protection" },
  { href: "/docs/plan", label: "postil plan (dry-run)" },
  { href: "/docs/envelope", label: "Envelope schema" },
  { href: "/docs/content-policy", label: "Content policy" },
  {
    href: "/docs/forges",
    label: "Forges",
    children: [
      { href: "/docs/forges/github", label: "GitHub" },
      { href: "/docs/forges/gitlab", label: "GitLab" },
      { href: "/docs/forges/bitbucket", label: "Bitbucket" },
      { href: "/docs/forges/azure", label: "Azure DevOps" },
    ],
  },
  { href: "/docs/self-hosted", label: "Self-hosted" },
  { href: "/docs/models", label: "Models and local inference" },
];

export function isDocsRouteWithin(pathname: string, href: string) {
  const route = href.split("#", 1)[0];
  return pathname === route || (route !== "/docs" && pathname.startsWith(`${route}/`));
}

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="mt-4 space-y-1.5 text-sm">
      {DOCS_NAV.map((item) => {
        const sectionActive = isDocsRouteWithin(pathname, item.href);
        const exactActive = pathname === item.href;
        return (
          <div key={item.href}>
            <Link
              href={item.href}
              aria-current={exactActive ? "page" : undefined}
              className={
                sectionActive
                  ? "block rounded border-l-2 border-rust bg-stone/60 px-2 py-1 font-medium text-charcoal"
                  : "block rounded px-2 py-1 text-charcoal/70 hover:bg-stone hover:text-charcoal"
              }
            >
              {item.label}
            </Link>
            {sectionActive && item.children ? (
              <div className="ml-3 mt-1 space-y-1 border-l border-charcoal/15 pl-2">
                {item.children.map((child) => {
                  const childActive = isDocsRouteWithin(pathname, child.href);
                  return (
                    <Link
                      key={child.href}
                      href={child.href}
                      aria-current={pathname === child.href ? "page" : undefined}
                      className={
                        childActive
                          ? "block rounded bg-stone/60 px-2 py-1 font-medium text-charcoal"
                          : "block rounded px-2 py-1 text-charcoal/70 hover:bg-stone hover:text-charcoal"
                      }
                    >
                      {child.label}
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
