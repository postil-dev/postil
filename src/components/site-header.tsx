import Image from "next/image";
import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-[color:var(--color-stone)] bg-[color:var(--color-ivory)]">
      <div className="container-page flex items-center justify-between py-4">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <Image
            src="/brand/postil-mark.svg"
            alt=""
            width={28}
            height={28}
            priority
          />
          <span className="font-serif text-xl font-medium tracking-tight text-[color:var(--color-charcoal)]">
            Postil
          </span>
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <Link href="/why-postil" className="hover:text-[color:var(--color-gate-deep)]">
            Why Postil
          </Link>
          <Link href="/how-it-works" className="hover:text-[color:var(--color-gate-deep)]">
            How it works
          </Link>
          <Link href="/pricing" className="hover:text-[color:var(--color-gate-deep)]">
            Pricing
          </Link>
          <Link href="/docs" className="hover:text-[color:var(--color-gate-deep)]">
            Docs
          </Link>
          <Link
            href="https://github.com/postil-dev/postil-cli"
            className="hover:text-[color:var(--color-gate-deep)]"
          >
            GitHub
          </Link>
          <Link href="/install" className="btn-primary text-sm">
            Install
          </Link>
        </nav>
      </div>
    </header>
  );
}
