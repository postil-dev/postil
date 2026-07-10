import type { Metadata } from "next";
import Link from "next/link";

import { PricingCalculator } from "@/components/pricing-calculator";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Free on public repos. Hosted teams get unlimited hosted reviews in a flat $10/developer plan. Self-hosted is free forever.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Postil pricing",
    description:
      "Unlimited hosted reviews, free self-hosting, and no per-review meter.",
    url: "https://postil.dev/pricing",
    images: ["/opengraph-image"],
  },
};

const FAQ = [
  {
    q: "What is my worst-case monthly cost?",
    a: "For the hosted Team plan, the customer-facing price is flat by developer. The public calculator compares published customer-facing prices only.",
  },
  {
    q: "Do I have to bring my own key?",
    a: "No. The hosted app includes reviews by default. Bring-your-own-key remains available for teams with a specific policy requirement.",
  },
  {
    q: "What does hosted Team cost?",
    a: "Hosted Team is $10 per developer per month with hosted reviews included. Public repositories, the local CLI, and the self-hosted stack remain free.",
  },
  {
    q: "Is the free tier actually free forever?",
    a: "Yes. The CLI and GitHub Action are Apache-2.0 and run locally or in your CI forever. Hosted reviews on public repositories are free, and the self-hosted stack (web, worker, Postgres) is free with no seat limit.",
  },
  {
    q: "Do you offer annual billing or invoicing?",
    a: "Contact us for annual billing or invoicing. The public calculator uses monthly list prices so comparisons stay simple.",
  },
] as const;

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Pricing</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Flat pricing, reviews included.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Pricing in this category usually takes one of two forms: per-review
        meters that scale cost with usage, or bundles that make a forecast
        hard. Postil charges a flat per-developer seat price with hosted
        reviews included.
      </p>

      {/* Tiers */}
      <div className="mt-14 grid gap-6 lg:grid-cols-3">
        <div className="card flex flex-col p-7">
          <p className="eyebrow">Free</p>
          <p className="serif-display mt-3 text-4xl">$0</p>
          <p className="mt-1 text-sm text-charcoal/70">forever</p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Hosted reviews on public repositories</li>
            <li>The full CLI, locally and in CI (Apache-2.0)</li>
            <li>GitHub Action with pinned-SHA installs</li>
            <li>CodeRabbit config translation (reads .coderabbit.yaml)</li>
          </ul>
          <Link href="/install" className="btn-secondary mt-8 text-center">
            Install the CLI
          </Link>
        </div>

        <div className="card flex flex-col border-gate p-7">
          <div className="flex items-center justify-between">
            <p className="eyebrow">Team</p>
            <span className="rounded-full border border-gate px-2.5 py-0.5 font-mono text-[11px] text-gate">
              reviews included
            </span>
          </div>
          <p className="serif-display mt-3 text-4xl">$10</p>
          <p className="mt-1 text-sm text-charcoal/70">
            per developer per month, flat
          </p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Private repositories, unlimited reviews</li>
            <li>Unlimited hosted reviews included</li>
            <li>BYO key support for custom policy requirements</li>
            <li>postil/gate for branch protection</li>
            <li>Silence-rate and confidence dashboards</li>
            <li>Incremental re-review on every push</li>
          </ul>
          <Link href="/install" className="btn-primary mt-8 text-center">
            Install the App
          </Link>
          <p className="mt-4 text-xs text-charcoal/70">
            Procurement, invoicing, SSO, or DPA requirements?{" "}
            <a
              href="mailto:hello@postil.dev"
              className="text-rust underline"
            >
              Talk to us
            </a>
            .
          </p>
        </div>

        <div className="card flex flex-col p-7">
          <p className="eyebrow">Self-hosted</p>
          <p className="serif-display mt-3 text-4xl">Free</p>
          <p className="mt-1 text-sm text-charcoal/70">forever, no seat limit</p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Docker Compose: Postgres, web, worker</li>
            <li>Startup validation with actionable errors</li>
            <li>OpenRouter, Azure OpenAI, Ollama, vLLM, and LiteLLM documented</li>
            <li>postil doctor verifies endpoint, key, and reviewer config</li>
          </ul>
          <Link href="/docs/self-hosted" className="btn-secondary mt-8 text-center">
            Self-host guide
          </Link>
        </div>
      </div>

      {/* Calculator */}
      <div className="mt-20">
        <div className="rule pt-8">
          <p className="eyebrow">The calculator</p>
          <h2 className="serif-display mt-3 text-3xl">
            What does your team actually pay?
          </h2>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Compared against published customer-facing prices for CodeRabbit
            Pro, Greptile, Qodo Pro Team, Macroscope, and Copilot Business.
            Where a competitor uses usage pricing or unpublished review
            consumption, the calculator shows a range or a floor instead of
            inventing a precise total.
          </p>
        </div>
        <div className="mt-8">
          <PricingCalculator />
        </div>
      </div>

      {/* FAQ */}
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
