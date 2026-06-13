import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs CodeRabbit",
  description:
    "Postil is a CodeRabbit alternative with a hard merge gate, a published silence metric, flat $10/dev BYO-key pricing, and free self-hosting — compared honestly, as of June 2026.",
  alternates: { canonical: "/vs/coderabbit" },
  openGraph: {
    title: "Postil vs CodeRabbit",
    description:
      "A hard merge gate, a published silence metric, flat BYO-key pricing, and free self-hosting. The honest comparison.",
    url: "https://postil.dev/vs/coderabbit",
    images: ["/opengraph-image"],
  },
};

const COLUMNS = ["Postil", "CodeRabbit"];

const ROWS: ComparisonRow[] = [
  {
    feature: "Hard merge gate (separate blocking check)",
    cells: [
      { kind: "yes", note: "postil/gate, fail-closed" },
      { kind: "no", note: "comments only" },
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
      { kind: "text", note: "~$24/seat (Pro, annual)" },
    ],
  },
  {
    feature: "Self-host without enterprise sales",
    cells: [
      { kind: "yes", note: "free, Docker Compose" },
      { kind: "partial", note: "enterprise-gated" },
    ],
  },
  {
    feature: "Platforms",
    cells: [
      {
        kind: "text",
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps (early)",
      },
      { kind: "text", note: "GitHub, GitLab, Azure DevOps, Bitbucket" },
    ],
  },
  {
    feature: "Config compatibility",
    cells: [
      { kind: "yes", note: "reads .coderabbit.yaml" },
      { kind: "yes", note: "native" },
    ],
  },
];

export default function VsCodeRabbitPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Compare</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Postil vs CodeRabbit
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        CodeRabbit is the most widely deployed AI reviewer and has the broadest
        platform coverage today. Postil is a CodeRabbit alternative built around
        restraint and structure: a hard merge gate separate from advisory
        comments, a published silence rate, and flat pricing that does not punish
        high PR volume.
      </p>

      <div className="mt-12">
        <ComparisonTable
          columns={COLUMNS}
          rows={ROWS}
          caption="Postil compared with CodeRabbit across merge gate, silence metric, pricing, self-hosting, platforms, and config compatibility."
        />
        <p className="mt-3 font-mono text-xs text-charcoal/60">
          Compiled from vendor pricing and documentation as of June 2026.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>The merge gate is the difference that matters</h2>
        <p>
          CodeRabbit posts blocking-severity and style-level findings as
          equivalent PR comments. Teams that want &quot;block on critical, ignore
          nits&quot; rebuild that logic by hand from raw check statuses. Postil
          ships it: <code>postil/gate</code> fails only at or above your
          configured severity and is safe to require in branch protection, while{" "}
          <code>postil/review</code> carries everything advisory. On operational
          errors the gate fails closed by default; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only.
        </p>

        <h2>Noise is a measured number, not a vibe</h2>
        <p>
          An{" "}
          <a href="https://lycheeorg.dev/2025-09-13-code-rabbit/" rel="noopener">
            independent audit of 28 CodeRabbit-reviewed PRs
          </a>{" "}
          rated 15% of its comments useless and another 21% nitpicking. Postil
          ships with a high confidence threshold by default and reports its
          silence rate — the share of PRs where it said nothing — as the first
          number on the dashboard, with the confidence distribution of every
          finding it did ship.
        </p>

        <h2>Flat pricing survives 10x PR volume</h2>
        <p>
          Postil charges a flat $10 per developer per month for orchestration and
          routes inference through your own key at provider rates with zero
          markup. Your worst-case bill is seats times ten, regardless of whether
          your team opens 40 or 400 PRs each. Run the numbers on the{" "}
          <Link href="/pricing">cost calculator</Link>.
        </p>

        <h2>Where CodeRabbit is ahead</h2>
        <p>
          CodeRabbit&apos;s Azure DevOps and Bitbucket support is mature and
          widely deployed. Postil&apos;s CLI supports both behind the same forge
          abstraction that covers GitHub and GitLab, but that support is early —
          shipped and covered by tests, not yet validated against live
          instances — and Postil&apos;s hosted app is GitHub-only. If you want a
          battle-tested reviewer on Bitbucket or Azure DevOps today, CodeRabbit
          covers you now.
        </p>
      </div>

      <div className="rounded-card shadow-card mt-12 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">
            Keep your <code className="font-mono text-xl">.coderabbit.yaml</code>.
          </h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Postil reads it. Install the CLI and run a review on your next diff.
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
