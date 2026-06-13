import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs Qodo",
  description:
    "Postil is a Qodo alternative with flat $10/dev BYO-key pricing instead of seats plus credits, a hard merge gate, and self-hosting of the full product, not a separate open-source tool. Compared honestly, as of June 2026.",
  alternates: { canonical: "/vs/qodo" },
  openGraph: {
    title: "Postil vs Qodo",
    description:
      "Flat BYO-key pricing instead of seats plus credits, a hard merge gate, and a published silence metric. The honest comparison.",
    url: "https://postil.dev/vs/qodo",
    images: ["/opengraph-image"],
  },
};

const COLUMNS = ["Postil", "Qodo"];

const ROWS: ComparisonRow[] = [
  {
    feature: "Hard merge gate (separate blocking check)",
    cells: [
      { kind: "yes", note: "postil/gate, fail-closed" },
      { kind: "no", note: "no separable blocking check" },
    ],
  },
  {
    feature: "Published silence / quiet-rate metric",
    cells: [{ kind: "yes", note: "headline dashboard number" }, { kind: "no" }],
  },
  {
    feature: "Pricing",
    cells: [
      { kind: "text", note: "Flat $10/dev, BYO key, zero markup" },
      { kind: "text", note: "Teams $30/user annual ($38 monthly) + credits" },
    ],
  },
  {
    feature: "Self-host without enterprise sales",
    cells: [
      { kind: "yes", note: "free, Docker Compose; same product as hosted" },
      { kind: "yes", note: "via open-source PR-Agent (AGPL)" },
    ],
  },
  {
    feature: "BYO key and local models (Ollama)",
    cells: [
      { kind: "yes", note: "every deployment mode" },
      { kind: "partial", note: "via open-source PR-Agent" },
    ],
  },
  {
    feature: "Platforms",
    cells: [
      {
        kind: "text",
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps (early)",
      },
      {
        kind: "text",
        note: "GitHub, GitLab, Bitbucket, Azure DevOps; PR-Agent adds Gitea, CodeCommit",
      },
    ],
  },
];

export default function VsQodoPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Compare</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Postil vs Qodo
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Qodo (formerly Codium) is the one major competitor with a genuine
        self-hosting story, through its open-source PR-Agent. Postil is a Qodo
        alternative for teams who want the self-hostable thing to be the whole
        product, priced flat instead of through seats and a credit meter, with
        a merge gate you can require in branch protection.
      </p>

      <div className="mt-12">
        <ComparisonTable
          columns={COLUMNS}
          rows={ROWS}
          caption="Postil compared with Qodo across merge gate, silence metric, pricing, self-hosting, BYO key, and platforms."
        />
        <p className="mt-3 font-mono text-xs text-charcoal/60">
          Compiled from vendor pricing and documentation as of June 2026.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>Credit where due: PR-Agent is real self-hosting</h2>
        <p>
          <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
            PR-Agent
          </a>{" "}
          is open source (AGPL), runs with your own key, and supports local
          models through Ollama, including air-gapped setups. Among the major
          vendors it is the credible answer for teams that cannot send code to
          an external API, and we say so plainly. The difference is what you
          get: PR-Agent is a separate open-source tool, while Qodo&apos;s
          hosted Teams product is its own thing with its own credit system.
          Self-hosted Postil is the same product as hosted Postil, gate,
          silence metric, dashboard and all, via{" "}
          <Link href="/docs/self-hosted">Docker Compose</Link> with OpenRouter,
          Azure, and Ollama examples.
        </p>

        <h2>Seats plus credits is two meters</h2>
        <p>
          Qodo Teams costs{" "}
          <a href="https://www.qodo.ai/pricing/" rel="noopener">
            $30 per user per month annual, $38 monthly
          </a>{" "}
          as of June 2026, roughly double the widely cited $19 of 2025, and
          meters usage in credits on top (premium models consume five credits
          per request). The free tier is credit-limited; Qodo&apos;s docs and
          pricing page describe its limits differently, so verify both before
          relying on it. Postil charges a flat $10 per developer per month and
          routes inference through your own key at provider rates with zero
          markup, so the bill does not move with model choice or review
          volume. Run the numbers on the <Link href="/pricing">cost
          calculator</Link>.
        </p>

        <h2>A gate you can require</h2>
        <p>
          Postil separates enforcement from commentary: <code>postil/gate</code>{" "}
          is a real check you can require in branch protection, failing only at
          or above your configured severity, while <code>postil/review</code>{" "}
          carries everything advisory. On operational errors the gate fails
          closed by default; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only. We did not find a documented equivalent of a separable
          blocking check in Qodo&apos;s materials as of June 2026; if that
          changes, this page will too.
        </p>

        <h2>Noise is measured, not promised</h2>
        <p>
          Practitioner sentiment has bundled Qodo into the category&apos;s
          noise complaints: one founder reported CodeRabbit and Qodo{" "}
          <a
            href="https://www.reddit.com/r/ycombinator/comments/1nl0too/coderabbit_raises_60m_valued_at_550m_thoughts/"
            rel="noopener"
          >
            &quot;at best added noise to PRs, at worst flagged false
            positives&quot;
          </a>
          . Qodo&apos;s own benchmark ranks Qodo first, a pattern shared by{" "}
          <a
            href="https://deepsource.com/blog/ai-code-review-benchmarks"
            rel="noopener"
          >
            every vendor benchmark in the category
          </a>
          . Postil does not publish a benchmark where it wins. It publishes a
          silence rate, the share of PRs where it said nothing, as the first
          number on the dashboard, with the confidence distribution of every
          finding it did ship.
        </p>

        <h2>Where Qodo is ahead</h2>
        <p>
          Qodo&apos;s hosted platform coverage is broad (GitHub, GitLab,
          Bitbucket, Azure DevOps), PR-Agent extends it further (Gitea, AWS
          CodeCommit), and its enterprise tier offers on-prem and air-gapped
          deployment with a SOC 2 Type II posture. The PR-Agent community is
          large and established. If you want an open-source reviewer with years
          of contributors behind it, PR-Agent is the incumbent and a fair
          default.
        </p>
      </div>

      <div className="rounded-card shadow-card mt-12 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">One product, one price.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Self-hosted or hosted, it is the same gate and the same flat $10.
            Install the CLI and try it on your next diff.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/install" className="btn-primary text-center">
            Install the CLI
          </Link>
          <Link
            href="/why-postil"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            Full comparison
          </Link>
        </div>
      </div>
    </div>
  );
}
