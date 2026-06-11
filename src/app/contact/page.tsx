import Link from "next/link";
import type { Metadata } from "next";
import { AnchorHeading, PageFrame, SectionIntro } from "../site";

export const metadata: Metadata = {
  title: "Contact",
  description: "Public contact options for Postil.",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Contact"
            title="Use the channel that matches the kind of issue."
            body="Security reports should go through the security page. General questions can use the public email address below."
            id="top"
          />
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 md:grid-cols-2">
          <article className="border bg-card p-6">
            <AnchorHeading id="security" as="h2" className="text-3xl">
              Security
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Vulnerability reports, sensitive disclosures, and verification questions should use
              the dedicated security page.
            </p>
            <Link href="/security" className="mt-6 inline-flex text-sm text-primary hover:underline">
              Open the security page
            </Link>
          </article>

          <article className="border bg-card p-6">
            <AnchorHeading id="general-inquiries" as="h2" className="text-3xl">
              General inquiries
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              For non-security questions, email hello@postil.dev.
            </p>
            <p className="mt-4 text-xs leading-6 text-muted-foreground">
              If your mail client or browser rewrites addresses, copy the address from this page
              instead of using an embedded mail link.
            </p>
          </article>
        </div>
      </section>
    </PageFrame>
  );
}
