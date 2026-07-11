import Image from "next/image";
import Link from "next/link";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/why-postil", label: "Why Postil" },
      { href: "/evidence", label: "See it run" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/pricing", label: "Pricing" },
      { href: "/security", label: "Security" },
      { href: "/install", label: "Install" },
      { href: "/changelog", label: "Changelog" },
      { href: "/blog", label: "Blog" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/cli", label: "CLI reference" },
      { href: "/docs/config", label: "Configuration" },
      { href: "/docs/forges", label: "Forges" },
      { href: "/docs/self-hosted", label: "Self-hosted" },
      { href: "/docs/gate", label: "The gate" },
    ],
  },
  {
    title: "Compare",
    links: [
      { href: "/vs/coderabbit", label: "vs CodeRabbit" },
      { href: "/vs/greptile", label: "vs Greptile" },
      { href: "/vs/qodo", label: "vs Qodo" },
      { href: "/vs/macroscope", label: "vs Macroscope" },
      { href: "/vs/copilot", label: "vs Copilot" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: "https://github.com/postil-dev/postil", label: "GitHub" },
      { href: "https://github.com/postil-dev/postil-cli", label: "CLI source" },
      { href: "/contact", label: "Contact" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/.well-known/security.txt", label: "security.txt" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-stone bg-ivory">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <Image
              src="/brand/postil-mark.svg"
              alt=""
              width={28}
              height={38}
              loading="eager"
            />
            <p className="serif-display mt-4 text-lg">
              AI review that can block a merge.
            </p>
            <p className="mt-2 text-sm text-charcoal/70">
              A low-noise review gate for teams shipping at agent speed.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-4">
            {COLUMNS.map((col) => (
              <nav key={col.title} aria-labelledby={`footer-${col.title}`}>
                <h2 id={`footer-${col.title}`} className="eyebrow">
                  {col.title}
                </h2>
                <ul className="mt-3 space-y-2 text-sm">
                  {col.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-charcoal/75 hover:text-charcoal"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>
        <div className="rule mt-10 pt-6 text-xs text-charcoal/75">
          <p>
            Postil. CLI and Action are Apache-2.0. Hosted reviews are included
            on Team. No code is persisted by the control plane; review
            envelopes only.
          </p>
        </div>
      </div>
    </footer>
  );
}
