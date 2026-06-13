import Image from "next/image";
import Link from "next/link";

import { MobileNav, type NavItem } from "@/components/mobile-nav";

const NAV: readonly NavItem[] = [
  { href: "/why-postil", label: "Why Postil" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/evidence", label: "See it run" },
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
            width={130}
            height={45}
            priority
          />
        </Link>
        <nav
          aria-label="Primary"
          className="hidden items-center gap-6 text-[15px] lg:flex xl:gap-7"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-charcoal/80 transition-colors hover:text-charcoal"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="hidden text-[15px] text-charcoal/80 hover:text-charcoal lg:inline-block"
          >
            Sign in
          </Link>
          <Link
            href="/install"
            className="btn-primary hidden text-sm sm:inline-block"
          >
            Install the CLI
          </Link>
          <MobileNav items={NAV} />
        </div>
      </div>
    </header>
  );
}
