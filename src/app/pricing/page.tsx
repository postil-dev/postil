import type { Metadata } from "next";
import Link from "next/link";

import { PricingCalculator } from "@/components/pricing-calculator";
import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_INFERENCE_ALLOWANCE_USD,
} from "@/lib/pricing-policy";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Hosted reviews are $15 per active private-PR author with a pooled inference allowance. BYOK is $9 per active author. Public repositories are free.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Postil pricing",
    description:
      "Hosted and BYOK plans priced by active private-PR author, with no repository charge.",
    url: "https://postil.dev/pricing",
    images: ["/opengraph-image"],
  },
};

const FAQ = [
  {
    q: "Who counts as an active author?",
    a: "A GitHub identity, including a bot or service identity, whose private-repository pull request Postil reviews during the billing month. An identity counts once per organization, regardless of repository or review count.",
  },
  {
    q: "What happens when Hosted uses its allowance?",
    a: "Hosted includes $6 of inference per active author, pooled across the organization. Overage defaults to $0. An organization owner must explicitly set a higher hard cap before Postil can incur additional hosted inference charges.",
  },
  {
    q: "How does BYOK billing work?",
    a: "Postil charges $9 per active author. Your model provider bills inference directly. Set budgets, hard limits, and alerts with the provider because Postil cannot enforce limits on charges in an external provider account.",
  },
  {
    q: "Are repositories billed?",
    a: "No. Pricing follows active private-PR authors, not repositories. The same identity is billed separately when it works for unrelated organization customers, and is deduplicated across organizations covered by one contracted enterprise account.",
  },
  {
    q: "What is included for public repositories?",
    a: "Hosted public-repository reviews are free, subject to the service-protection fair-use terms. The CLI and self-hosted stack have no license cost.",
  },
] as const;

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Pricing</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Pay for authors who use Postil.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        The organization is the customer. Private-repository plans count the
        GitHub identities whose pull requests Postil reviews during the month.
        There is no repository charge.
      </p>

      <div className="mt-14 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <div className="card flex flex-col p-7">
          <p className="eyebrow">Public</p>
          <p className="serif-display mt-3 text-4xl">$0</p>
          <p className="mt-1 text-sm text-charcoal/70">per organization</p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Hosted public-repository reviews</li>
            <li>Service-protection fair use</li>
            <li>CLI and GitHub Action</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install the App
          </Link>
        </div>

        <div className="card flex flex-col border-gate p-7">
          <p className="eyebrow">Hosted</p>
          <p className="serif-display mt-3 text-4xl">
            ${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD}
          </p>
          <p className="mt-1 text-sm text-charcoal/70">
            per active author / month
          </p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>
              ${HOSTED_INFERENCE_ALLOWANCE_USD} inference allowance per author,
              pooled organization-wide
            </li>
            <li>$0 default overage</li>
            <li>Owner-controlled hard cap for additional usage</li>
            <li>Private repositories with no repository fee</li>
          </ul>
          <Link href="/install" className="btn-primary mt-8 text-center">
            Install the App
          </Link>
        </div>

        <div className="card flex flex-col p-7">
          <p className="eyebrow">BYOK</p>
          <p className="serif-display mt-3 text-4xl">
            ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD}
          </p>
          <p className="mt-1 text-sm text-charcoal/70">
            per active author / month
          </p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Use your model provider and credentials</li>
            <li>Provider usage billed directly to you</li>
            <li>Provider budgets and limits control spend</li>
            <li>Private repositories with no repository fee</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install the App
          </Link>
        </div>

        <div className="card flex flex-col p-7">
          <p className="eyebrow">Self-hosted</p>
          <p className="serif-display mt-3 text-4xl">Free</p>
          <p className="mt-1 text-sm text-charcoal/70">Apache-2.0, no license cost</p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Docker Compose deployment</li>
            <li>Your infrastructure and inference account</li>
            <li>The same review gate and dashboard</li>
          </ul>
          <Link
            href="/docs/self-hosted"
            className="btn-secondary mt-8 text-center"
          >
            Self-host guide
          </Link>
        </div>
      </div>

      <div className="mt-8 rounded-card border border-stone bg-paper p-6 text-sm text-ink-soft">
        An active author is a GitHub identity, including a bot or service
        identity, whose private-repository PR Postil reviews in the billing
        month. One identity counts once per organization. Related organizations
        under one enterprise contract share identity deduplication. See the{" "}
        <Link
          href="/terms#billing-and-fair-use"
          className="text-rust underline"
        >
          billing and fair-use terms
        </Link>
        .
      </div>

      <div className="mt-20">
        <div className="rule pt-8">
          <p className="eyebrow">Calculator</p>
          <h2 className="serif-display mt-3 text-3xl">
            Estimate by active author.
          </h2>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Postil totals use active private-PR authors. Competitor cards retain
            each vendor&apos;s published billing unit.
          </p>
        </div>
        <div className="mt-8">
          <PricingCalculator />
        </div>
      </div>

      <div className="mt-20">
        <div className="rule pt-8">
          <p className="eyebrow">Questions</p>
          <h2 className="serif-display mt-3 text-3xl">Billing, plainly.</h2>
        </div>
        <dl className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {FAQ.map((item) => (
            <div key={item.q}>
              <dt className="serif-display text-lg">{item.q}</dt>
              <dd className="mt-2 text-[15px] text-ink-soft">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
