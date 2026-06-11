import type { Metadata } from "next";
import Link from "next/link";
import { AnchorHeading, PageFrame, SectionIntro } from "../site";

export const metadata: Metadata = {
  title: "Security",
  description: "How to report security issues to Postil.",
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Security"
            title="Report vulnerabilities through the path that reaches a human."
            body="Use GitHub Security Advisories for sensitive reports. The machine-readable security.txt stays available for scanners and tooling."
            id="top"
          />
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-2">
          <article className="border bg-card p-6">
            <AnchorHeading id="preferred-report-path" as="h2" className="text-3xl">
              Preferred report path
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              For vulnerabilities in the public site or related services, open a GitHub Security
              Advisory so the report stays private while we triage it.
            </p>
            <Link
              href="https://github.com/postil-dev/postil/security/advisories/new"
              className="mt-6 inline-flex text-sm text-primary hover:underline"
            >
              Open a GitHub Security Advisory
            </Link>
          </article>

          <article className="border bg-card p-6">
            <AnchorHeading id="what-to-include" as="h2" className="text-3xl">
              What to include
            </AnchorHeading>
            <ul className="mt-4 grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-foreground">
              <li>The page or route you tested.</li>
              <li>Reproduction steps and expected behavior.</li>
              <li>Browser, device, or runtime details if they matter.</li>
              <li>Whether the issue is public, authenticated, or local only.</li>
            </ul>
          </article>

          <article className="border bg-card p-6 lg:col-span-2">
            <AnchorHeading id="machine-readable-contact" as="h2" className="text-3xl">
              Machine-readable contact
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Automated tooling can use the public security policy file at{" "}
              <Link href="/.well-known/security.txt" className="text-primary hover:underline">
                /.well-known/security.txt
              </Link>
              .
            </p>
          </article>
        </div>
      </section>
    </PageFrame>
  );
}
