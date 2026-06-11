import Link from "next/link";
import type { Metadata } from "next";
import { AnchorHeading, PageFrame, SectionIntro } from "../site";

export const metadata: Metadata = {
  title: "Brand",
  description: "Public brand assets, logo files, and usage notes for Postil.",
  alternates: { canonical: "/brand" },
};

const assetLinks = [
  { href: "/brand/postil-logo.svg", label: "Logo SVG" },
  { href: "/brand/postil-mark.svg", label: "Mark SVG" },
  { href: "/brand/postil-mark-square.svg", label: "Square mark SVG" },
  { href: "/brand/postil-hero-gate-sketch.png", label: "Hero image PNG" },
];

export default function BrandPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Brand"
            title="Public brand assets and usage notes for Postil."
            body="This page is the stable download surface for press, partners, and builders. For the fuller system, use the brand guidelines."
            id="top"
          />
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-3">
          <article className="border bg-card p-6">
            <AnchorHeading id="treatment" as="h2" className="text-3xl">
              Page treatment
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              This page is a public asset hub, not a full identity manual. It gives people the
              files they need quickly, then points them to the canonical guidelines for rules and
              rationale.
            </p>
            <ul className="mt-4 grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-foreground">
              <li>Use the downloads below when you need a logo or mark for the product.</li>
              <li>Use the brand guidelines when you need the full system or usage rules.</li>
              <li>Use the contact link if you need help choosing the right file.</li>
            </ul>
          </article>

          <article className="border bg-card p-6">
            <AnchorHeading id="downloadable-assets" as="h2" className="text-3xl">
              Downloadable assets
            </AnchorHeading>
            <ul className="mt-4 grid gap-2 text-sm leading-6 text-muted-foreground">
              {assetLinks.map((asset) => (
                <li key={asset.href}>
                  <Link href={asset.href} className="text-primary hover:underline">
                    {asset.label}
                  </Link>
                </li>
              ))}
            </ul>
          </article>

          <article className="border bg-card p-6">
            <AnchorHeading id="usage-notes" as="h2" className="text-3xl">
              Usage notes
            </AnchorHeading>
            <ul className="mt-4 grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-foreground">
              <li>Use the supplied files as-is.</li>
              <li>Do not stretch, recolor, or redraw the logo.</li>
              <li>Prefer the horizontal lockup when the product name needs to stay visible.</li>
              <li>Use the square mark for small placements and favicon-style use.</li>
            </ul>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              The fuller brand reference remains in{" "}
              <Link
                href="https://github.com/postil-dev/postil/blob/main/docs/brand-guidelines.md"
                className="text-primary hover:underline"
              >
                the brand guidelines
              </Link>
              .
            </p>
          </article>

          <article className="border bg-card p-6 lg:col-span-3">
            <AnchorHeading id="need-more-detail" as="h2" className="text-3xl">
              Need the full system?
            </AnchorHeading>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-muted-foreground">
              The brand guidelines cover the logo system, color, typography, and website direction.
              Start there if you are making a press kit, a partner page, or a layout decision that
              depends on the broader visual system.
            </p>
          </article>
        </div>
      </section>
    </PageFrame>
  );
}
