import Image from "next/image";
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-[color:var(--color-stone)] mt-24 bg-[color:var(--color-ivory)]">
      <div className="container-page py-10 grid gap-8 md:grid-cols-4 text-sm">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Image src="/brand/postil-mark.svg" alt="" width={20} height={20} />
            <span className="font-serif text-base font-medium">Postil</span>
          </div>
          <p className="text-[color:var(--color-charcoal-soft)] leading-relaxed">
            A low-noise review gate. Hosted beta at postil.dev. CLI under Apache-2.0.
          </p>
        </div>
        <div>
          <div className="font-medium mb-2">Product</div>
          <ul className="space-y-1.5 text-[color:var(--color-charcoal-soft)]">
            <li><Link href="/why-postil">Why Postil</Link></li>
            <li><Link href="/how-it-works">How it works</Link></li>
            <li><Link href="/pricing">Pricing</Link></li>
            <li><Link href="/install">Install</Link></li>
          </ul>
        </div>
        <div>
          <div className="font-medium mb-2">Docs</div>
          <ul className="space-y-1.5 text-[color:var(--color-charcoal-soft)]">
            <li><Link href="/docs">Quickstart</Link></li>
            <li><Link href="/docs/config">.postil.yaml</Link></li>
            <li><Link href="/docs/self-hosted">Self-hosted</Link></li>
            <li><Link href="/docs/envelope">Review envelope</Link></li>
          </ul>
        </div>
        <div>
          <div className="font-medium mb-2">Open source</div>
          <ul className="space-y-1.5 text-[color:var(--color-charcoal-soft)]">
            <li>
              <Link href="https://github.com/postil-dev/postil-cli">postil-cli (Rust engine)</Link>
            </li>
            <li>
              <Link href="https://github.com/postil-dev/postil-action">postil-action</Link>
            </li>
            <li>
              <Link href="https://github.com/postil-dev/postil">postil (backend + site)</Link>
            </li>
            <li><Link href="/privacy">Privacy</Link></li>
          </ul>
        </div>
      </div>
      <div className="container-page border-t border-[color:var(--color-stone)] py-5 text-xs text-[color:var(--color-charcoal-soft)] flex justify-between">
        <span>© Postil contributors. Apache-2.0.</span>
        <span className="font-mono">Trust the merge, not the speed.</span>
      </div>
    </footer>
  );
}
