import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Postil vs Greptile",
  description:
    "Postil is a Greptile alternative with active-author pricing, a hard merge gate, a published silence metric, BYOK, and free self-hosting.",
  alternates: { canonical: "/vs/greptile" },
  openGraph: {
    title: "Postil vs Greptile",
    description:
      "Active-author pricing, a hard merge gate, BYOK, and a published silence metric. The honest comparison.",
    url: "https://postil.dev/vs/greptile",
    images: ["/opengraph-image"],
  },
};

const COLUMNS = ["Postil", "Greptile"];

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
      { kind: "text", note: "$15 Hosted or $9 BYOK per active author" },
      { kind: "text", note: "~$30/seat + ~$1 per review past 50" },
    ],
  },
  {
    feature: "Cost at high PR volume",
    cells: [
      { kind: "text", note: "Hosted owner cap; BYOK provider controls" },
      { kind: "no", note: "scales with review count" },
    ],
  },
  {
    feature: "Self-host without enterprise sales",
    cells: [
      { kind: "yes", note: "free, Docker Compose" },
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
      { kind: "text", note: "GitHub, GitLab" },
    ],
  },
];

export default function VsGreptilePage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Compare</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">
        Postil vs Greptile
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Greptile&apos;s cross-file reasoning is genuinely strong. Postil is a
        Greptile alternative for teams who hit the limits of its commercial model
        and merge contract: per-review overage pricing scales sharply at
        agent-team volume, and findings ship as comments rather than a separable,
        enforceable gate.
      </p>

      <div className="mt-12">
        <ComparisonTable
          columns={COLUMNS}
          rows={ROWS}
          caption="Postil compared with Greptile across merge gate, silence metric, pricing, cost at high PR volume, self-hosting, and platforms."
        />
        <p className="mt-3 font-mono text-xs text-charcoal/70">
          Sources: vendor pricing and documentation.
        </p>
      </div>

      <div className="prose-postil mt-14 max-w-none">
        <h2>Per-review pricing breaks at agent speed</h2>
        <p>
          Greptile&apos;s{" "}
          <a href="https://www.greptile.com/blog/greptile-v4" rel="noopener">
            March 2026 move
          </a>{" "}
          to $30/seat plus $1 per review past 50 produced a{" "}
          <a href="https://greptile-fail.vercel.app/" rel="noopener">
            public backlash
          </a>
          . A developer pushing several hundred agent-driven PRs in a month can
          owe hundreds of dollars. Postil Hosted is $15 per active author with
          a $6 pooled inference allowance per author. BYOK is $9 per active
          author plus direct provider charges. Compare on the{" "}
          <Link href="/pricing">cost calculator</Link>.
        </p>

        <h2>A gate that can block a merge</h2>
        <p>
          Greptile posts findings as PR comments. Postil completes{" "}
          <code>postil/gate</code> as a real, separable check you can require in
          branch protection, distinct from advisory <code>postil/review</code>{" "}
          commentary. On operational errors the gate fails closed by default
          rather than completing neutral; repos can opt into{" "}
          <code>gate.onError: advisory</code>, which fails open on provider
          outages only.
        </p>

        <h2>Restraint is measured</h2>
        <p>
          <a href="https://www.greptile.com/blog/greptile-v4" rel="noopener">
            Greptile&apos;s own v4 release notes
          </a>{" "}
          show comments-addressed rising from 30% to 43% between versions,
          evidence that defaults trend noisy. Postil reports its silence rate and the
          confidence distribution of shipped findings as the headline metrics, so
          drift toward noise is visible in a chart before engineers feel it in
          notifications.
        </p>

        <h2>Where Greptile is ahead</h2>
        <p>
          Greptile&apos;s cross-file recall on large codebases is a real strength,
          and it has a longer track record on deep repository context. Postil
          optimizes the precision of what it says over breadth of recall.
        </p>
      </div>

      <div className="rounded-card shadow-card mt-12 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-2xl">Pay for active private-PR authors.</h2>
          <p className="mt-2 max-w-md text-sm text-ivory/70">
            Choose Hosted or BYOK. Install the CLI and
            try it on your next diff.
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
