import type { Metadata } from "next";
import Link from "next/link";

import {
  ComparisonTable,
  type ComparisonRow,
} from "@/components/comparison-table";

export const metadata: Metadata = {
  title: "Why Postil",
  description:
    "Postil as a CodeRabbit alternative: where it differs from CodeRabbit, Greptile, Copilot, and the rest — silence rate, flat pricing with BYO keys, a hard merge gate, and self-hosting that works.",
  alternates: { canonical: "/why-postil" },
  openGraph: {
    title: "Why Postil — the honest comparison",
    description:
      "Hard merge gate, a published silence metric, flat BYO-key pricing, real self-hosting. Postil vs CodeRabbit, Greptile, and Copilot code review.",
    url: "https://postil.dev/why-postil",
    images: ["/opengraph-image"],
  },
};

const COMPARISON_COLUMNS = [
  "Postil",
  "CodeRabbit",
  "Greptile",
  "Copilot code review",
];

const COMPARISON_ROWS: ComparisonRow[] = [
  {
    feature: "Hard merge gate (separate blocking check)",
    cells: [
      { kind: "yes", note: "postil/gate, fail-closed" },
      { kind: "no", note: "comments only" },
      { kind: "no", note: "comments only" },
      { kind: "partial", note: "neutral check, not blocking" },
    ],
  },
  {
    feature: "Published silence / quiet-rate metric",
    cells: [
      { kind: "yes", note: "headline dashboard number" },
      { kind: "no" },
      { kind: "no" },
      { kind: "no" },
    ],
  },
  {
    feature: "Pricing model",
    cells: [
      { kind: "text", note: "Flat $10/dev, BYO key, zero markup" },
      { kind: "text", note: "~$24/seat (Pro, annual)" },
      { kind: "text", note: "Per-seat + per-review overage" },
      { kind: "text", note: "AI Credits + Actions minutes (Jun 2026)" },
    ],
  },
  {
    feature: "Self-host (no enterprise gate)",
    cells: [
      { kind: "yes", note: "free, Docker Compose" },
      { kind: "partial", note: "enterprise sales" },
      { kind: "no" },
      { kind: "no" },
    ],
  },
  {
    feature: "Platforms",
    cells: [
      {
        kind: "text",
        note: "Hosted app: GitHub. CLI/CI: GitHub, GitLab, Bitbucket + Azure DevOps (early); off GitHub the gate is a CI job pass/fail, not a named check-run",
      },
      { kind: "text", note: "GitHub, GitLab, Azure DevOps, Bitbucket" },
      { kind: "text", note: "GitHub, GitLab" },
      { kind: "text", note: "GitHub" },
    ],
  },
];

interface Wedge {
  number: string;
  title: string;
  body: React.ReactNode;
  status: React.ReactNode;
}

const wedges: Wedge[] = [
  {
    number: "01",
    title: "A provable silence rate",
    body: (
      <>
        <p>
          An{" "}
          <a href="https://lycheeorg.dev/2025-09-13-code-rabbit/" rel="noopener">
            independent audit of 28 CodeRabbit-reviewed PRs
          </a>{" "}
          rated 15% of its comments useless noise and another 21% nitpicking.{" "}
          <a href="https://www.greptile.com/blog/greptile-v4" rel="noopener">
            Greptile's own v4 release notes
          </a>{" "}
          show comments-addressed rising from 30% to 43% between versions —
          defaults in this category trend noisy.
        </p>
        <p className="mt-3">
          Postil ships with a high confidence threshold by default and reports
          its silence rate — the share of PRs where it said nothing — as the
          first number on your dashboard, with the confidence distribution of
          every finding it did ship.{" "}
          <a
            href="https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/"
            rel="noopener"
          >
            GitHub reports
          </a>{" "}
          that Copilot code review stays silent on roughly 29% of reviews, but
          the number lives in a blog post, not on your dashboard; we make it
          the headline.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">no incumbent surfaces this metric</span>,
  },
  {
    number: "02",
    title: "Flat $10/dev orchestration, BYO key, zero markup",
    body: (
      <>
        <p>
          CodeRabbit Pro is{" "}
          <a href="https://www.coderabbit.ai/pricing" rel="noopener">
            $24 per seat per month on the annual plan
          </a>{" "}
          as of June 2026. Greptile's{" "}
          <a href="https://www.greptile.com/blog/greptile-v4" rel="noopener">
            March 2026 move
          </a>{" "}
          to $30/seat plus $1 per review past 50 produced a{" "}
          <a href="https://greptile-fail.vercel.app/" rel="noopener">
            public backlash site
          </a>
          ; a{" "}
          <a href="https://x.com/mg/status/2029751037716836478" rel="noopener">
            developer pushing 571 agent-driven PRs in 30 days
          </a>{" "}
          would owe roughly $500 a month. GitHub moved Copilot code review{" "}
          <a
            href="https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/"
            rel="noopener"
          >
            onto Actions-minutes billing in June 2026
          </a>
          ; the{" "}
          <a
            href="https://github.com/orgs/community/discussions/192948"
            rel="noopener"
          >
            community discussion
          </a>{" "}
          of the underlying usage-based billing change ran 958 downvotes to 24
          upvotes, with one developer reporting 8% of a monthly allotment
          burned in two hours.
        </p>
        <p className="mt-3">
          Postil charges a flat $10 per developer per month for orchestration
          and routes inference through your own OpenRouter, Anthropic, Azure,
          or Bedrock key at provider rates, with zero markup. Worst-case bill:
          seats times ten. As of June 2026, the closest comparable model we
          found is{" "}
          <a href="https://kodus.io/pricing/" rel="noopener">
            Kodus
          </a>
          , at $8 plus passthrough, with minimal distribution.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">survives 10x PR volume by construction</span>,
  },
  {
    number: "03",
    title: "A hard gate, separate from advisory comments",
    body: (
      <>
        <p>
          Every major tool posts blocking-severity and style-level findings as
          equivalent PR comments. GitHub Copilot's review completes as a
          neutral grey check that reads as "didn't fail". Teams that want
          "block on critical, ignore nits" build it by hand from raw check
          statuses.
        </p>
        <p className="mt-3">
          Postil completes two named check-runs on every PR:{" "}
          <code>postil/gate</code> fails only at or above your configured
          severity and is safe to require in branch protection;{" "}
          <code>postil/review</code> carries everything advisory. On
          operational errors the gate fails closed by default — never neutral.
          Repos can opt into <code>gate.onError: advisory</code>, which fails
          open on provider outages only.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">a category-first CI primitive</span>,
  },
  {
    number: "04",
    title: "Every major forge through one CLI",
    body: (
      <>
        <p>
          Many of the highest-precision review tools are GitHub-only. Teams on
          GitLab Self-Managed in regulated industries are left choosing between
          platform support and review quality.
        </p>
        <p className="mt-3">
          Postil's CLI speaks GitHub, GitLab, Bitbucket, and Azure DevOps —
          each including its self-managed/server variant via a base-URL
          environment variable — through the same forge interface. Bitbucket
          and Azure DevOps support is early: shipped and covered by tests, not
          yet validated against live instances. The CLI's interactive{" "}
          <code>@postil</code> bot (<code>postil respond</code>) follows the
          same reach: GitHub and GitLab cover issues and PRs/MRs, Bitbucket and
          Azure DevOps cover pull requests only. The hosted app is GitHub-only
          today. Off GitHub the gate is enforced as a CI job that passes or
          fails, rather than a named external check-run like GitHub's{" "}
          <code>postil/gate</code>.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">same engine, same gate semantics</span>,
  },
  {
    number: "05",
    title: "Self-hosted that works on the first run — including Ollama",
    body: (
      <>
        <p>
          PR-Agent's self-hosted config{" "}
          <a
            href="https://github.com/qodo-ai/pr-agent/issues/2083"
            rel="noopener"
          >
            silently fell back to OpenAI
          </a>{" "}
          when pointed at non-OpenAI models, and a{" "}
          <a
            href="https://github.com/The-PR-Agent/pr-agent/issues/2287"
            rel="noopener"
          >
            v0.33 regression
          </a>{" "}
          overwrote non-OpenAI API keys with dummy values.{" "}
          <a href="https://bito.ai/pricing/" rel="noopener">
            Bito charges a $5/seat add-on
          </a>{" "}
          for self-hosting. CodeRabbit gates it behind enterprise sales.
        </p>
        <p className="mt-3">
          Postil ships a Docker Compose that brings up Postgres, the web app,
          and the worker, validates every required setting at startup with an
          actionable error message, and documents working configs for
          OpenRouter, Azure OpenAI, and local Ollama.{" "}
          <code>postil doctor</code> verifies your endpoint, key, and model
          before the first review. Free forever.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">&lt;15 minutes from clone to first review</span>,
  },
  {
    number: "06",
    title: "Incremental re-review",
    body: (
      <>
        <p>
          Most tools re-review the whole PR on every push, so a one-line fixup
          triggers a fresh flood.{" "}
          <a
            href="https://cursor.com/changelog/bugbot-updates-june-2026"
            rel="noopener"
          >
            Cursor BugBot shipped incremental review in June 2026
          </a>
          ; few others have it.
        </p>
        <p className="mt-3">
          Postil records the envelope of every completed review. On the next
          push it reviews only what changed since the last reviewed commit,
          reconciles prior findings, and reports "N resolved, M open" instead
          of repeating itself. The control plane passes the previous envelope
          to the CLI automatically.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">we track our own history</span>,
  },
  {
    number: "07",
    title: "postil plan: a dry-run for review config",
    body: (
      <>
        <p>
          No incumbent shows you what a config change would have done before
          you deploy it. Teams tune review settings by trial and error against
          live PRs, for weeks.
        </p>
        <p className="mt-3">
          <code>postil plan</code> re-applies a candidate config to your stored
          envelopes — no model calls, no API spend — and shows exactly which
          findings would have shipped, been suppressed, or failed the gate on
          your recent PRs. Terraform-plan semantics for review configuration.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">a category first</span>,
  },
];

export default function WhyPostilPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 md:py-20">
      <p className="eyebrow">Why Postil</p>
      <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
        The honest comparison.
      </h1>
      <p className="mt-6 max-w-3xl text-lg text-ink-soft">
        Every claim below links to its source: vendor pricing pages, public
        post-mortems, and independent audits as of June 2026. Where a
        competitor is better, we say so: CodeRabbit's platform coverage is more
        battle-tested today, and Greptile's cross-file recall is genuinely
        strong. Here is where Postil is different.
      </p>

      {/* At-a-glance comparison */}
      <div className="mt-12">
        <p className="eyebrow">At a glance</p>
        <h2 className="serif-display mt-2 text-2xl">How the category lines up.</h2>
        <p className="mt-3 max-w-2xl text-[15px] text-ink-soft">
          Compiled from vendor pricing and documentation as of June 2026.
          Competitor capabilities change; the sourced detail behind each row is
          in the wedges below.
        </p>
        <div className="mt-6">
          <ComparisonTable
            columns={COMPARISON_COLUMNS}
            rows={COMPARISON_ROWS}
            caption="Postil compared with CodeRabbit, Greptile, and Copilot code review across merge gate, silence metric, pricing model, self-hosting, and platform coverage."
          />
        </div>
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[13px] text-charcoal/75">
          <span>Compare in detail:</span>
          <Link
            href="/vs/coderabbit"
            className="whitespace-nowrap text-rust underline"
          >
            Postil vs CodeRabbit
          </Link>
          <Link
            href="/vs/greptile"
            className="whitespace-nowrap text-rust underline"
          >
            Postil vs Greptile
          </Link>
          <Link
            href="/vs/qodo"
            className="whitespace-nowrap text-rust underline"
          >
            Postil vs Qodo
          </Link>
          <Link
            href="/vs/macroscope"
            className="whitespace-nowrap text-rust underline"
          >
            Postil vs Macroscope
          </Link>
          <Link
            href="/vs/copilot"
            className="whitespace-nowrap text-rust underline"
          >
            Postil vs Copilot
          </Link>
        </p>
      </div>

      <div className="mt-14 space-y-12">
        {wedges.map((w) => (
          <section key={w.number} className="rule grid gap-6 pt-10 md:grid-cols-[1fr_3fr]">
            <div>
              <p className="font-mono text-sm text-charcoal/70">{w.number}</p>
              <h2 className="serif-display mt-1 text-2xl">{w.title}</h2>
              <p className="mt-3">{w.status}</p>
            </div>
            <div className="prose-postil max-w-none text-[15px]">{w.body}</div>
          </section>
        ))}
      </div>

      <div className="card mt-16 p-8">
        <h2 className="serif-display text-2xl">Where we are honest about trade-offs</h2>
        <ul className="mt-4 space-y-2 text-[15px] text-ink-soft">
          <li>
            Bitbucket and Azure DevOps support in the CLI is early: shipped and
            covered by tests, but not yet validated against live instances. The
            hosted app is GitHub-only. If you want a battle-tested reviewer on
            Bitbucket or Azure DevOps today, CodeRabbit covers you now.
          </li>
          <li>
            No AI reviewer catches every real bug; independent benchmarks find
            current systems{" "}
            <a href="https://arxiv.org/abs/2509.01494" rel="noopener">
              substantially underperform on real pull requests
            </a>
            . Postil optimizes the precision of what it says, not the claim that
            it catches everything.
          </li>
          <li>
            The hosted app is in beta. The CLI and self-hosted stack are the
            stable surface.
          </li>
        </ul>
        <p className="mt-6">
          <Link href="/pricing" className="link-arrow">
            Compare costs with the calculator
          </Link>
        </p>
      </div>

      <div className="rounded-card shadow-card mt-10 flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="serif-display text-3xl">See it on your own diff.</h2>
          <p className="mt-2 max-w-xl text-sm text-ivory/70">
            Install the CLI in one line and run a review before you push. If we
            have nothing merge-relevant to say, you will hear nothing.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
          <Link href="/install" className="btn-primary text-center">
            Install the CLI
          </Link>
          <Link
            href="/how-it-works"
            className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
          >
            How it works
          </Link>
        </div>
      </div>
    </div>
  );
}
