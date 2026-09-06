import Image from "next/image";
import Link from "next/link";

import { HeaderActions } from "@/components/auth-nav";
import type { NavItem } from "@/components/mobile-nav";

const NAV: readonly NavItem[] = [
  { href: "/why-postil", label: "Why Postil" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/evidence", label: "See it run" },
  { href: "/bench", label: "Bench" },
  { href: "/pricing", label: "Pricing" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
] as const;

export function SiteHeader() {
  return (
    <header className="relative border-b border-stone bg-ivory">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" aria-label="Postil home" className="shrink-0">
          <Image
            src="/brand/postil-logo.svg"
            alt="Postil"
            width={148}
            height={48}
            priority
          />
        </Link>
        <nav
          aria-label="Primary"
          className="hidden items-center gap-5 text-[15px] xl:flex"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap text-charcoal/80 transition-colors hover:text-charcoal"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <HeaderActions items={NAV} />
        </div>
      </div>
    </header>
  );
}
