import type { Metadata } from "next";
import Link from "next/link";

import { PricingCalculator } from "@/components/pricing-calculator";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Free on public repos. Hosted teams can bring their own inference key or use managed inference with transparent pass-through markup. Self-hosted is free forever.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Postil pricing",
    description:
      "BYO key or managed inference, transparent model pricing, free self-hosting, and no per-review orchestration meter.",
    url: "https://postil.dev/pricing",
    images: ["/opengraph-image"],
  },
};

const FAQ = [
  {
    q: "What is my worst-case monthly cost?",
    a: "Your orchestration cost is flat by seat. Inference is either paid directly to your provider with BYOK or billed as managed pass-through with a visible markup. There are no hidden credits or per-review orchestration overages.",
  },
  {
    q: "Do I have to bring my own key?",
    a: "No. BYOK remains available for teams that already have OpenRouter, Anthropic, Azure OpenAI, Bedrock, vLLM, or Ollama set up. Managed inference is the easier path: Postil holds the provider key and bills model cost with a transparent 0.5% to 5.0% markup.",
  },
  {
    q: "What does the hosted beta cost today?",
    a: "Nothing. While the GitHub App is in beta, Team-plan orchestration is free and your account carries a beta badge. The $10 flat rate applies when the beta ends; you will be told well in advance and can leave with your data.",
  },
  {
    q: "Is the free tier actually free forever?",
    a: "Yes. The CLI and GitHub Action are Apache-2.0 and run locally or in your CI forever. Hosted reviews on public repositories are free, and the self-hosted stack (web, worker, Postgres) is free with no seat limit.",
  },
  {
    q: "What happens at 10x PR volume?",
    a: "Your Postil bill does not change. Flat orchestration was chosen specifically because agentic workflows can push hundreds of PRs per developer per month — one publicly documented developer hit 571 in 30 days — where per-review pricing produces bills in the hundreds of dollars per developer.",
  },
  {
    q: "Do you offer annual billing or invoicing?",
    a: "During the beta, no payment is collected at all. Annual invoicing for the Team plan will be available at general availability.",
  },
] as const;

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Pricing</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        Flat orchestration. BYO key or managed inference.
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Pricing in this category fails in one of two ways: per-review meters
        that punish fast teams, or opaque bundles that hide the model bill.
        Postil does neither: seats are predictable, model cost is explicit.
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
              hosted beta: free
            </span>
          </div>
          <p className="serif-display mt-3 text-4xl">$10</p>
          <p className="mt-1 text-sm text-charcoal/70">
            per developer per month, flat
          </p>
          <ul className="mt-6 flex-1 space-y-2.5 text-sm text-ink-soft">
            <li>Private repositories, unlimited reviews</li>
            <li>BYO inference key at zero markup</li>
            <li>Managed inference with transparent 0.5% to 5.0% markup</li>
            <li>postil/gate for branch protection</li>
            <li>Silence-rate and confidence dashboards</li>
            <li>Incremental re-review on every push</li>
          </ul>
          <Link href="/install" className="btn-primary mt-8 text-center">
            Install the App
          </Link>
          <p className="mt-4 text-xs text-charcoal/70">
            Over 50 seats, or have procurement, invoicing, or DPA questions?{" "}
            <a
              href="mailto:hello@postil.dev"
              className="text-rust underline"
            >
              Talk to us
            </a>
            . SSO/SAML and a formal DPA are on the roadmap; contact us to
            discuss requirements.
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
            <li>postil doctor verifies endpoint, key, and model</li>
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
            Compared against CodeRabbit Pro at its published $24/user/mo annual
            rate and Greptile&apos;s metered model ($30/seat plus per-review
            overage past the included allowance). Pick a model to calculate
            inference from prompt and completion tokens instead of guessing a
            cents-per-review number.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-charcoal/70">
            Model prices are read from the public{" "}
            <a
              href="https://openrouter.ai/api/v1/models"
              className="text-rust underline"
              rel="noopener"
            >
              OpenRouter model catalog
            </a>
            .
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
