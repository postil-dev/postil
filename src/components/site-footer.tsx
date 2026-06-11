import Image from "next/image";
import Link from "next/link";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/why-postil", label: "Why Postil" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/pricing", label: "Pricing" },
      { href: "/security", label: "Security" },
      { href: "/install", label: "Install" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs/quickstart", label: "Quickstart" },
      { href: "/docs/cli", label: "CLI reference" },
      { href: "/docs/config", label: "Configuration" },
      { href: "/docs/gitlab", label: "GitLab" },
      { href: "/docs/self-hosted", label: "Self-hosted" },
      { href: "/docs/gate", label: "The gate" },
    ],
  },
  {
    title: "Compare",
    links: [
      { href: "/vs/coderabbit", label: "vs CodeRabbit" },
      { href: "/vs/greptile", label: "vs Greptile" },
    ],
  },
  {
    title: "Project",
    links: [
      { href: "https://github.com/postil-dev/postil", label: "GitHub" },
      { href: "https://github.com/postil-dev/postil-cli", label: "CLI source" },
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
            <Image src="/brand/postil-mark.svg" alt="" width={28} height={38} />
            <p className="serif-display mt-4 text-lg">
              Trust the merge, not the speed.
            </p>
            <p className="mt-2 text-sm text-charcoal/60">
              A low-noise review gate for teams shipping at agent speed.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-4">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <p className="eyebrow">{col.title}</p>
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
              </div>
            ))}
          </div>
        </div>
        <div className="rule mt-10 pt-6 text-xs text-charcoal/65">
          <p>
            Postil. CLI and Action are Apache-2.0. Hosted beta is free while in
            beta. No code is persisted by the control plane; review envelopes
            only.
          </p>
        </div>
      </div>
    </footer>
  );
}
