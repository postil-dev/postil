import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs GitHub Copilot code review",
  description:
    "Postil is a Copilot code review alternative with a blocking merge gate (Copilot reviews are comment-only), flat $10/dev BYO-key pricing instead of AI Credits, and free self-hosting. Compared honestly, as of June 2026.",
  alternates: { canonical: "/vs/copilot" },
  openGraph: {
    title: "Postil vs GitHub Copilot code review",
    description:
      "A blocking merge gate where Copilot is comment-only, flat BYO-key pricing instead of AI Credits, and free self-hosting. The honest comparison.",
    url: "https://postil.dev/vs/copilot",
    images: ["/opengraph-image"],
  },
};

const COLUMNS = ["Postil", "Copilot code review"];

const ROWS: ComparisonRow[] = [
  {
    feature: "Hard merge gate (separate blocking check)",
    cells: [
      { kind: "yes", note: "postil/gate, fail-closed" },
      {
        kind: "no",
        note: "always a Comment review; never counts toward required approvals",
      },
    ],
  },
  {
    feature: "Published silence / quiet-rate metric",
    cells: [
      { kind: "yes", note: "headline dashboard number" },
      { kind: "partial", note: "a one-off blog statistic, not a product metric" },
    ],
  },
  {
    feature: "Pricing",
    cells: [
      { kind: "text", note: "Flat $10/dev, BYO key, zero markup" },
      {
        kind: "text",
        note: "Paid Copilot plan + AI Credits + Actions minutes per review",
      },
    ],
  },
  {
    feature: "Cost predictability",
    cells: [
      { kind: "yes", note: "flat: seats × $10" },
      { kind: "no", note: "usage-billed since June 2026" },
    ],
  },
  {
    feature: "BYO key / model choice",
    cells: [{ kind: "yes" }, { kind: "no" }],
  },
  {
    feature: "Self-host",
    cells: [{ kind: "yes", note: "free, Docker Compose" }, { kind: "no" }],
  },
  {
    feature: "Platforms",
    cells: [
      {
        kind: "text",
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps (early)",
      },
      { kind: "text", note: "GitHub; Azure DevOps in preview" },
    ],
  },
];

export default function VsCopilotPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Compare</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Postil vs Copilot code review
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Copilot code review is the easiest reviewer to turn on: it is already
        in the GitHub plan many teams pay for. Postil is an alternative for
        teams who hit its two structural limits, a review that can never block
        a merge, and usage-based billing that made per-review cost
        unpredictable.
      </p>

      <div className="mt-12">
        <ComparisonTable
          columns={COLUMNS}
          rows={ROWS}
          caption="Postil compared with GitHub Copilot code review across merge gate, silence metric, pricing, cost predictability, model choice, self-hosting, and platforms."
        />
        <p className="mt-3 font-mono text-xs text-charcoal/70">
          Compiled from vendor pricing and documentation as of June 2026.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>Copilot cannot block a merge, by design</h2>
        <p>
          Per{" "}
          <a
            href="https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review"
            rel="noopener"
          >
            GitHub&apos;s own documentation
          </a>
          , Copilot always submits a &quot;Comment&quot; review, never
          &quot;Request changes,&quot; and never counts toward required
          approvals. Whatever it finds, the merge button stays green.
          Enterprises asking for an enforcement mode is an{" "}
          <a
            href="https://github.com/orgs/community/discussions/184163"
            rel="noopener"
          >
            open community discussion
          </a>
          . Postil separates the two roles: <code>postil/review</code> carries
          advisory commentary, and <code>postil/gate</code> is a real pass/fail
          check you can require in branch protection. On operational errors the
          gate fails closed by default; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only.
        </p>

        <h2>AI Credits made review cost a variable</h2>
        <p>
          Copilot moved to usage-based{" "}
          <a
            href="https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/"
            rel="noopener"
          >
            &quot;AI Credits&quot; billing
          </a>{" "}
          on June 1, 2026, and code review now also{" "}
          <a
            href="https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/"
            rel="noopener"
          >
            consumes GitHub Actions minutes
          </a>{" "}
          per agentic run; legacy plans saw a{" "}
          <a
            href="https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/"
            rel="noopener"
          >
            13x premium-request multiplier
          </a>{" "}
          for review. Users report large cost swings, including{" "}
          <a
            href="https://www.reddit.com/r/GithubCopilot/comments/1tvjhm1/i_wholeheartedly_recommend_to_everyone_to_turn/"
            rel="noopener"
          >
            one who burned an entire month&apos;s included credits on a single
            automatic PR review
          </a>
          . Postil charges a flat $10 per developer per month and routes
          inference through your own key at provider list rates with zero
          markup, so the bill is known before the month starts. Run your
          numbers on the <Link href="/pricing">cost calculator</Link>.
        </p>

        <h2>Silence as a product metric, not a blog post</h2>
        <p>
          To GitHub&apos;s credit, it has published the closest thing to a
          silence number from any major vendor:{" "}
          <a
            href="https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/"
            rel="noopener"
          >
            Copilot code review stays silent on roughly 29% of reviews
          </a>
          . But that figure lives in a blog post. Postil reports your silence
          rate, on your PRs, as the first number on the dashboard, with the
          confidence distribution of every finding it shipped, so you can see
          whether restraint holds on your codebase rather than on an average.
        </p>

        <h2>Data handling depends on your plan</h2>
        <p>
          On Copilot Free and Pro, interaction data is used for model training
          unless you opt out (
          <a
            href="https://github.blog/news-insights/company-news/updates-to-github-copilot-interaction-data-usage-policy/"
            rel="noopener"
          >
            policy since April 2025
          </a>
          ); Business and Enterprise plans are excluded. There is no model
          choice and no BYO key on any tier. With Postil, code goes to the
          inference provider you chose under your own key and your own DPA, and
          the self-hosted deployment keeps it inside your network entirely. The
          control plane stores review envelopes, never code.
        </p>

        <h2>Where Copilot is ahead</h2>
        <p>
          Zero setup if your org already pays for Copilot, the deepest native
          GitHub integration in the category, and the broadest organizational
          adoption:{" "}
          <a href="https://pullflow.com/state-of-ai-code-review-2025" rel="noopener">
            Pullflow&apos;s analysis of 40.3M public PRs
          </a>{" "}
          found Copilot leads org adoption among AI reviewers. It is also
          improving quickly: an{" "}
          <a
            href="https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/"
            rel="noopener"
          >
            agentic architecture went GA in March 2026
          </a>
          , followed by severity levels and grouped comments. If you want
          advisory review with no procurement step, Copilot is the obvious first
          try.
        </p>
      </div>

      <div className="rounded-card shadow-card mt-12 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            Comments don&apos;t stop merges.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Require postil/gate in branch protection and keep Copilot if you
            like it. Install the CLI and try it on your next diff.
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
