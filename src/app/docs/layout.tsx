import Link from "next/link";

const DOCS_NAV = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/docs/config", label: "Configuration (.postil.yaml)" },
  { href: "/docs/gate", label: "The gate and branch protection" },
  { href: "/docs/plan", label: "postil plan (dry-run)" },
  { href: "/docs/envelope", label: "Envelope schema" },
  { href: "/docs/self-hosted", label: "Self-hosted" },
] as const;

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-6xl gap-12 px-6 py-14">
      <aside className="hidden w-56 shrink-0 lg:block">
        <p className="eyebrow">Documentation</p>
        <nav className="mt-4 space-y-1.5 text-sm">
          {DOCS_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded px-2 py-1 text-charcoal/70 hover:bg-stone hover:text-charcoal"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <article className="min-w-0 flex-1">{children}</article>
    </div>
  );
}
