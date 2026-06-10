import Image from "next/image";
import Link from "next/link";

const NAV = [
  { href: "/why-postil", label: "Why Postil" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/install", label: "Install" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-stone bg-ivory">
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
        <nav className="hidden items-center gap-7 text-[15px] md:flex">
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
          <Link href="/login" className="text-[15px] text-charcoal/80 hover:text-charcoal">
            Sign in
          </Link>
          <Link href="/install" className="btn-primary hidden text-sm sm:inline-block">
            Install
          </Link>
        </div>
      </div>
    </header>
  );
}
