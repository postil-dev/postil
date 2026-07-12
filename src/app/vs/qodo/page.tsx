import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs Qodo",
  description:
    "Postil is a Qodo alternative with active-author pricing instead of credit packs, a hard merge gate, and self-hosting of the full product.",
  alternates: { canonical: "/vs/qodo" },
  openGraph: {
    title: "Postil vs Qodo",
    description:
      "Active-author pricing instead of credit packs, a hard merge gate, and a published silence metric. The honest comparison.",
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
      { kind: "text", note: "$15 Hosted or $9 BYOK per active author" },
      { kind: "text", note: "Credit packs; $0.012/credit, $30 start" },
    ],
  },
  {
    feature: "Self-host without enterprise sales",
    cells: [
      { kind: "yes", note: "free, Docker Compose; same product as hosted" },
      { kind: "yes", note: "via open-source PR-Agent (Apache-2.0)" },
    ],
  },
  {
    feature: "BYOK and local models (Ollama)",
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
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps on a best-effort CI gate",
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
        product, priced by active private-PR author instead of through pooled
        credit packs, with a merge gate you can require in branch protection.
      </p>

      <div className="mt-12">
        <ComparisonTable
          columns={COLUMNS}
          rows={ROWS}
          caption="Postil compared with Qodo across merge gate, silence metric, pricing, self-hosting, BYOK, and platforms."
        />
        <p className="mt-3 font-mono text-xs text-charcoal/70">
          Sources: Qodo public pricing and usage docs, plus vendor public docs.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>Credit where due: PR-Agent is real self-hosting</h2>
        <p>
          <a href="https://github.com/qodo-ai/pr-agent" rel="noopener">
            PR-Agent
          </a>{" "}
          is open source (Apache-2.0), runs with your own key, and supports
          local models through Ollama, including air-gapped setups. Among the
          major vendors it is the credible answer for teams that cannot send
          code to an external API, and we say so plainly. The difference is what
          you get: PR-Agent is a separate open-source tool, while Qodo Pro Team
          is its hosted product with its own credit system.
          Self-hosted Postil is the same product as hosted Postil, gate,
          silence metric, dashboard and all, via{" "}
          <Link href="/docs/self-hosted">Docker Compose</Link> with OpenRouter,
          Azure, and Ollama examples.
        </p>

        <h2>Credit packs are still a usage meter</h2>
        <p>
          Qodo Pro Team is credit-pack based: public pricing shows a{" "}
          <a href="https://www.qodo.ai/pricing/" rel="noopener">
            $30 starting point, pooled credits at $0.012 per credit, and
            self-serve designed for up to 30 users.
          </a>{" "}
          Its{" "}
          <a href="https://docs.qodo.ai/pricing-and-usage" rel="noopener">
            usage docs
          </a>{" "}
          describe shared workspace credits and overage caps. Postil Hosted is
          $15 per active author with a $6 pooled inference allowance per author.
          BYOK is $9 per active author with direct provider charges. Run the
          numbers on the{" "}
          <Link href="/pricing">cost calculator</Link>.
        </p>

        <h2>A gate you can require</h2>
        <p>
          Postil separates enforcement from commentary: <code>postil/gate</code>{" "}
          is a real check you can require in branch protection, failing only at
          or above your configured severity, while <code>postil/review</code>{" "}
          carries everything advisory. On operational errors the gate fails
          closed by default; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only. Qodo&apos;s public materials describe review automation
          but do not document a separate branch-protection check equivalent to
          Postil&apos;s gate.
        </p>

        <h2>Practitioner-reported noise, and Postil's own numbers</h2>
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
          <h2 className="serif-display text-2xl">One product, clear pricing.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Hosted is $15 and BYOK is $9 per active private-PR author.
            Self-hosted stays free with the same gate and dashboard. Try it on
            your next diff.
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
