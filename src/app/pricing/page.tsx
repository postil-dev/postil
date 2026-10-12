import type { Metadata } from "next";
import Link from "next/link";

import { InfoTooltip } from "@/components/info-tooltip";
import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Every organization starts with a 30-day hosted trial. Public repositories are free with BYOK. Private plans start at $${BYOK_ACTIVE_AUTHOR_MONTHLY_USD} per active author each month after the trial.`,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Postil pricing",
    description:
      "Every organization starts with a 30-day hosted trial. Pay only for active private-repository authors after the trial.",
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
        Every organization starts with a 30-day hosted trial. No card or provider
        setup. Private plans count only authors whose pull requests Postil
        reviews. Repositories are not billed.
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
            <li>GitHub App with your model provider</li>
            <li>CLI and GitHub Action</li>
            <li>Service-protection fair use</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install with BYOK
          </Link>
        </div>

        <div className="card flex flex-col p-7">
          <h2 className="eyebrow">BYOK</h2>
          <p className="serif-display mt-3 text-4xl">
            ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD}
          </p>
          <ActiveAuthorUnit id="byok-active-author" />
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>30 days free, no card</li>
            <li>Your provider, models, and credentials</li>
            <li>Provider usage billed directly to you</li>
            <li>Unlimited reviews</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install with BYOK
          </Link>
        </div>

        <div className="card flex flex-col border-gate p-7">
          <h2 className="eyebrow">Hosted</h2>
          <p className="serif-display mt-3 text-4xl">
            ${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD}
          </p>
          <ActiveAuthorUnit id="hosted-active-author" />
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>30 days free, no card</li>
            <li>No API key needed, we supply the model</li>
            <li>Unlimited reviews</li>
            <li>Switch to BYOK at any time</li>
          </ul>
          <Link href="/install" className="btn-primary mt-8 text-center">
            Start 30-day trial
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

      <section id="compare" className="mt-14 scroll-mt-6" aria-labelledby="compare-pricing-heading">
        <h2 id="compare-pricing-heading" className="serif-display text-3xl">Compare review costs</h2>
        <p className="mt-3 max-w-3xl text-sm text-ink-soft">
          Seat fees, credit packs, and usage charges measure different things. These USD
          list prices show the billing unit and the charges to include in a team budget.
          Plan features and review limits differ; each vendor link opens its pricing terms.
        </p>
        {/* Vendor pricing sources verified 2026-09-05. */}
        <div className="mt-6 overflow-x-auto rounded-card border border-stone" tabIndex={0} role="region" aria-label="Review pricing comparison">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="bg-paper">
              <tr><th scope="col" className="p-4">Plan</th><th scope="col" className="p-4">Base price</th><th scope="col" className="p-4">Usage to account for</th></tr>
            </thead>
            <tbody className="divide-y divide-stone">
              <tr><th scope="row" className="p-4 font-medium">Postil BYOK</th><td className="p-4">${BYOK_ACTIVE_AUTHOR_MONTHLY_USD} / active author / month</td><td className="p-4">Model provider usage billed separately.</td></tr>
              <tr><th scope="row" className="p-4 font-medium">Postil Hosted</th><td className="p-4">${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD} / active author / month</td><td className="p-4">Hosted inference included, subject to <Link href="/terms#billing-and-fair-use" className="text-rust underline">fair use</Link>.</td></tr>
              <tr><th scope="row" className="p-4 font-medium"><a href="https://www.coderabbit.ai/pricing" className="text-rust underline">CodeRabbit Essentials</a></th><td className="p-4">$30 / developer / month</td><td className="p-4">$24 monthly equivalent with annual billing. Optional usage beyond included limits costs $0.25 per reviewed file.</td></tr>
              <tr><th scope="row" className="p-4 font-medium"><a href="https://www.greptile.com/pricing" className="text-rust underline">Greptile Pro</a></th><td className="p-4">$30 / seat / month</td><td className="p-4">50 credits per seat; $1 per additional credit. A standard review uses 1 credit, a TREX review 3.</td></tr>
              <tr><th scope="row" className="p-4 font-medium"><a href="https://www.qodo.ai/pricing/" className="text-rust underline">Qodo Pro Team</a></th><td className="p-4">From $30 / month</td><td className="p-4">2,500-credit team pack, advertised as about 18 reviews. Actual consumption depends on the review.</td></tr>
              <tr><th scope="row" className="p-4 font-medium"><a href="https://docs.macroscope.com/pricing" className="text-rust underline">Macroscope Balanced</a></th><td className="p-4">$0.05 / KB of reviewed diff</td><td className="p-4">10 KB minimum per review ($0.50). Detection mode changes the rate; other features have separate usage charges.</td></tr>
            </tbody>
          </table>
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
