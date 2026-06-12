import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-6 py-24 md:py-32">
      <p className="eyebrow">404</p>
      <h1 className="serif-display mt-4 max-w-2xl text-4xl md:text-5xl">
        Nothing here. And we will not pretend otherwise.
      </h1>
      <p className="mt-6 max-w-xl text-lg text-ink-soft">
        This URL has no page behind it. A reviewer that fabricates findings is
        worse than one that says nothing, so here is the honest version: the
        page you asked for does not exist.
      </p>
      <div className="mt-8 flex flex-wrap gap-4">
        <Link href="/" className="btn-primary">
          Back to home
        </Link>
        <Link href="/docs" className="btn-secondary">
          Read the docs
        </Link>
      </div>
      <div className="rule mt-12 w-full max-w-xl pt-6">
        <p className="font-mono text-xs text-charcoal/60">
          Looking for something specific?{" "}
          <Link href="/why-postil" className="text-rust underline">
            Why Postil
          </Link>
          {" · "}
          <Link href="/pricing" className="text-rust underline">
            Pricing
          </Link>
          {" · "}
          <Link href="/install" className="text-rust underline">
            Install
          </Link>
          {" · "}
          <Link href="/changelog" className="text-rust underline">
            Changelog
          </Link>
        </p>
      </div>
    </div>
  );
}
