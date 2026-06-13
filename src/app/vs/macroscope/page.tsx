import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs Macroscope",
  description:
    "Postil is a Macroscope alternative with flat $10/dev BYO-key pricing instead of per-kilobyte usage billing, a blocking merge gate instead of neutral checks, and free self-hosting. Compared honestly, as of June 2026.",
  alternates: { canonical: "/vs/macroscope" },
  openGraph: {
    title: "Postil vs Macroscope",
    description:
      "Flat BYO-key pricing instead of per-kilobyte billing, a blocking merge gate instead of neutral checks, and free self-hosting. The honest comparison.",
    url: "https://postil.dev/vs/macroscope",
    images: ["/opengraph-image"],
  },
};

const COLUMNS = ["Postil", "Macroscope"];

const ROWS: ComparisonRow[] = [
  {
    feature: "Hard merge gate (separate blocking check)",
    cells: [
      { kind: "yes", note: "postil/gate, fail-closed" },
      { kind: "no", note: "check runs complete neutral" },
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
      { kind: "text", note: "$0.05/KB of diff (~$0.95–$1.50 typical PR)" },
    ],
  },
  {
    feature: "Cost at high PR volume",
    cells: [
      { kind: "yes", note: "flat: seats × $10" },
      { kind: "no", note: "scales with diff size and PR count" },
    ],
  },
  {
    feature: "Self-host / BYO key",
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
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps (early)",
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
        offer: a check that can actually block a merge, a bill that does not
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
          Compiled from vendor pricing and documentation as of June 2026.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>A neutral check cannot protect a branch</h2>
        <p>
          Macroscope&apos;s check runs complete with a neutral conclusion (
          <a href="https://docs.macroscope.com/changelog" rel="noopener">
            per its docs
          </a>
          ), and GitHub branch protection cannot block on a neutral check. That
          makes its findings advisory by construction, whatever severity they
          carry. Postil completes <code>postil/gate</code> as a real pass/fail
          check you can require in branch protection, separate from advisory{" "}
          <code>postil/review</code> commentary. On operational errors the gate
          fails closed by default; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only.
        </p>

        <h2>Per-kilobyte billing puts a meter on your diff</h2>
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
          with a 10 KB minimum, around $0.95 to $1.50 for a typical PR. Two
          pricing models in six months. To its credit, Macroscope offers spend
          caps and $100 of credit for new workspaces, but the structure still
          charges you more for bigger changes and more PRs. Postil charges a
          flat $10 per developer per month and routes inference through your
          own key at provider rates with zero markup; your worst-case bill is
          seats times ten. Compare on the{" "}
          <Link href="/pricing">cost calculator</Link>.
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
          number on your own traffic, not a one-time benchmark result, so you
          can audit restraint continuously instead of trusting a launch post.
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
          inside your network, it is not currently an option.
        </p>
      </div>

      <div className="rounded-card shadow-card mt-12 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            A gate, not a suggestion.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Require postil/gate in branch protection and keep the bill flat.
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
