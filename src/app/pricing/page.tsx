import type { Metadata } from "next";
import Link from "next/link";

import { InfoTooltip } from "@/components/info-tooltip";
import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Public repositories are free. Hosted is $${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD} and BYOK is $${BYOK_ACTIVE_AUTHOR_MONTHLY_USD} per active private-PR author each month.`,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Postil pricing",
    description:
      "Private-repository plans are priced by active author, with no repository charge.",
    url: "https://postil.dev/pricing",
    images: ["/opengraph-image"],
  },
};

const activeAuthorDefinition = (
  <>
    A GitHub identity, including a bot or service identity, counts once per
    organization in a month when Postil reviews its private-repository pull
    request.
  </>
);

function ActiveAuthorUnit({ id }: { id: string }) {
  return (
    <p className="mt-1 flex items-center gap-1.5 text-sm text-charcoal/70">
      <span>per active author / month</span>
      <InfoTooltip id={id} label="What counts as an active author?">
        {activeAuthorDefinition}
      </InfoTooltip>
    </p>
  );
}

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Pricing</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Private code, priced by active authors.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Public repositories are free. Private plans count only authors whose
        pull requests Postil reviews. Repositories are not billed.
      </p>

      <section
        aria-label="Postil plans"
        className="mt-14 grid gap-6 md:grid-cols-2 xl:grid-cols-4"
      >
        <div className="card flex flex-col p-7">
          <h2 className="eyebrow">Public</h2>
          <p className="serif-display mt-3 text-4xl">$0</p>
          <p className="mt-1 text-sm text-charcoal/70">
            for public repositories
          </p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Hosted reviews</li>
            <li>CLI and GitHub Action</li>
            <li>Service-protection fair use</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install the App
          </Link>
        </div>

        <div className="card flex flex-col border-gate p-7">
          <h2 className="eyebrow">Hosted</h2>
          <p className="serif-display mt-3 text-4xl">
            ${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD}
          </p>
          <ActiveAuthorUnit id="hosted-active-author" />
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Private-repository reviews</li>
            <li>Postil operates model access</li>
            <li>Review volume is not a billing unit</li>
          </ul>
          <Link href="/install" className="btn-primary mt-8 text-center">
            Install the App
          </Link>
        </div>

        <div className="card flex flex-col p-7">
          <h2 className="eyebrow">BYOK</h2>
          <p className="serif-display mt-3 text-4xl">
            ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD}
          </p>
          <ActiveAuthorUnit id="byok-active-author" />
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Your provider, models, and credentials</li>
            <li>Provider usage billed directly to you</li>
            <li>Review volume is not a Postil billing unit</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install the App
          </Link>
        </div>

        <div className="card flex flex-col p-7">
          <h2 className="eyebrow">Self-hosted</h2>
          <p className="serif-display mt-3 text-4xl">Free</p>
          <p className="mt-1 text-sm text-charcoal/70">Apache-2.0</p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Run on your infrastructure</li>
            <li>Use your inference account</li>
            <li>No license fee</li>
          </ul>
          <Link
            href="/docs/self-hosted"
            className="btn-secondary mt-8 text-center"
          >
            Self-host guide
          </Link>
        </div>
      </section>

      <div className="mt-8 flex flex-col gap-4 rounded-card border border-stone bg-paper p-5 text-sm text-ink-soft sm:flex-row sm:items-center sm:justify-between">
        <p>
          Enterprise identity, audit, deployment, or contracting requirements?
        </p>
        <Link
          href="/contact"
          className="shrink-0 font-medium text-rust underline"
        >
          Talk to us
        </Link>
      </div>

      <p className="mt-6 text-sm text-charcoal/65">
        See the{" "}
        <Link href="/terms#billing-and-fair-use" className="text-rust underline">
          billing and fair-use terms
        </Link>
        .
      </p>
    </div>
  );
}
