import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs Macroscope",
  description:
    "Postil is a Macroscope alternative with active-author pricing, a dedicated fail-closed merge gate, BYOK, and free self-hosting.",
  alternates: { canonical: "/vs/macroscope" },
  openGraph: {
    title: "Postil vs Macroscope",
    description:
      "Active-author pricing, a dedicated fail-closed merge gate, BYOK, and free self-hosting. The honest comparison.",
    url: "https://postil.dev/vs/macroscope",
    images: ["/opengraph-image"],
  },
};

const COLUMNS = ["Postil", "Macroscope"];

const ROWS: ComparisonRow[] = [
  {
    feature: "Dedicated fail-closed merge gate",
    cells: [
      { kind: "yes", note: "postil/gate, fail-closed" },
      {
        kind: "text",
        note: "defaults neutral; can configure failure checks",
      },
    ],
  },
  {
    feature: "Published silence / quiet-rate metric",
    cells: [{ kind: "yes", note: "headline dashboard number" }, { kind: "no" }],
  },
  {
    feature: "Pricing",
    cells: [
      { kind: "text", note: "Per active private-PR author" },
      {
        kind: "text",
        note: "$0.05/KB of diff ($0.50 floor; $1.50 for a 30 KB medium feature)",
      },
    ],
  },
  {
    feature: "Cost at high PR volume",
    cells: [
      { kind: "text", note: "Hosted owner cap; BYOK provider controls" },
      { kind: "no", note: "scales with diff size and PR count" },
    ],
  },
  {
    feature: "Self-host / BYOK",
    cells: [
      { kind: "yes", note: "free, Docker Compose, incl. Ollama" },
      { kind: "no" },
    ],
  },
  {
    feature: "Platforms",
    cells: [
      {
        kind: "text",
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps on a best-effort CI gate",
      },
      { kind: "text", note: "GitHub Cloud only" },
    ],
  },
];

export default function VsMacroscopePage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Compare</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Postil vs Macroscope
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Macroscope ships fast and takes precision seriously. Postil is a
        Macroscope alternative for teams who need three things it does not
        put first: a dedicated fail-closed merge gate, a bill that does not
        scale with diff size, and a deployment that runs anywhere other than
        GitHub Cloud.
      </p>

      <div className="mt-12">
        <ComparisonTable
          columns={COLUMNS}
          rows={ROWS}
          caption="Postil compared with Macroscope across merge gate, silence metric, pricing, cost at high PR volume, self-hosting, and platforms."
        />
        <p className="mt-3 font-mono text-xs text-charcoal/70">
          Sources: vendor pricing and documentation.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>A neutral default is advisory until configured</h2>
        <p>
          Macroscope{" "}
          <a
            href="https://docs.macroscope.com/check-run-agents"
            rel="noopener"
          >
            Check Run Agents
          </a>{" "}
          default to a neutral conclusion ceiling, and GitHub branch protection
          cannot block on a neutral check. Macroscope{" "}
          <a href="https://docs.macroscope.com/approvability" rel="noopener">
            Approvability
          </a>{" "}
          can also be configured to conclude failure as a required status check,
          so the product can gate merges when a team opts into that mode. Postil
          makes the gate a separate pass/fail check from the start: require{" "}
          <code>postil/gate</code> in branch protection while{" "}
          <code>postil/review</code> stays advisory. On operational errors the
          gate fails closed by default; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only.
        </p>

        <h2>Per-kilobyte billing charges by diff size</h2>
        <p>
          Macroscope{" "}
          <a
            href="https://techcrunch.com/2025/09/17/meet-macroscope-an-ai-tool-for-understanding-your-code-base-fixing-bugs/"
            rel="noopener"
          >
            launched in September 2025 at $30 per developer per month with a
            five-seat minimum
          </a>
          , then flipped to usage-based pricing in March 2026:{" "}
          <a href="https://docs.macroscope.com/pricing" rel="noopener">
            $0.05 per kilobyte of diff
          </a>{" "}
          with a 10 KB minimum. Its docs describe most reviews as under the
          minimum, or $0.50, with a 30 KB medium feature at $1.50. Two pricing
          models in six months. To its credit, Macroscope offers spend caps, but
          the structure still charges you more for bigger changes and more PRs.
          Postil prices private plans by active author. BYOK provider usage is
          billed directly. See the <Link href="/pricing">pricing details</Link>.
        </p>

        <h2>Precision claims vs a standing metric</h2>
        <p>
          Macroscope&apos;s V3 review claims 98% precision and 64 to 80% fewer
          nitpicks (
          <a
            href="https://macroscope.com/blog/code-review-benchmark"
            rel="noopener"
          >
            self-published benchmark
          </a>
          , in a category where{" "}
          <a
            href="https://deepsource.com/blog/ai-code-review-benchmarks"
            rel="noopener"
          >
            every vendor benchmark ranks its own author first
          </a>
          ). We make no counter-claim about whose findings are more precise.
          The difference is the reporting: Postil publishes its silence rate,
          the share of PRs where it said nothing, as a standing dashboard
          number on your own traffic, so you can audit restraint continuously
          rather than relying on a single launch-post benchmark.
        </p>

        <h2>Where Macroscope is ahead</h2>
        <p>
          Macroscope builds an AST and reference graph across several languages,
          giving it structural context a diff-first reviewer does not have. It
          ships quickly (
          <a href="https://docs.macroscope.com/changelog" rel="noopener">
            check-run agents and a CLI both landed in May 2026
          </a>
          ), and its usage pricing includes spend caps, which several
          usage-priced competitors lack. If you are entirely on GitHub Cloud and want its
          codebase-understanding features, it is a serious product. If you are
          on GitLab, Bitbucket, self-managed anything, or need code to stay
          inside your network, it is not an option.
        </p>
      </div>

      <div className="rounded-card shadow-card mt-12 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            A merge gate that actually blocks.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Require postil/gate in branch protection and choose Hosted or BYOK.
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
