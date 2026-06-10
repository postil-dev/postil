import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Why Postil",
  description:
    "Where Postil differs from CodeRabbit, Greptile, Copilot, and the rest: silence rate, flat pricing with BYO keys, a hard merge gate, and self-hosting that works.",
};

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
          An independent audit of 28 CodeRabbit-reviewed PRs rated 15% of its
          comments useless noise and another 21% nitpicking. Greptile's own v4
          release notes show why defaults trend noisy: engagement rose from 30%
          to 43% only after they tuned low-value comments down. The category
          optimizes for visible activity.
        </p>
        <p className="mt-3">
          Postil ships with a high confidence threshold by default and reports
          its silence rate — the share of PRs where it said nothing — as the
          first number on your dashboard, with the confidence distribution of
          every finding it did ship. GitHub Copilot stays silent on roughly 29%
          of PRs but never tells the team; we make the number the headline.
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
          Greptile's March 2026 move to $30/seat plus $1 per review past 50
          produced a public backlash site and churn; a developer pushing 571
          agent-driven PRs in 30 days would owe roughly $500 a month. GitHub
          Copilot's June 2026 shift to Actions-minutes billing drew a 958-to-24
          downvote ratio after one developer burned 8% of a monthly allotment
          in two hours.
        </p>
        <p className="mt-3">
          Postil charges a flat $10 per developer per month for orchestration
          and routes inference through your own OpenRouter, Anthropic, Azure,
          or Bedrock key at provider rates, with zero markup. Worst-case bill:
          seats times ten. Only Kodus offers a comparable model today, at $8
          plus passthrough, with minimal distribution.
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
          operational errors the gate fails closed — never neutral.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">a category-first CI primitive</span>,
  },
  {
    number: "04",
    title: "GitHub and GitLab, including self-managed",
    body: (
      <>
        <p>
          Nine of the eighteen tools we track are GitHub-only — including the
          highest-precision ones: Cubic, Graphite Agent, Macroscope, and
          Ellipsis. Teams on GitLab Self-Managed in regulated industries are
          left choosing between platform support and review quality.
        </p>
        <p className="mt-3">
          Postil's CLI speaks GitHub and GitLab — including self-managed
          instances via a custom base URL — through the same forge interface,
          with Bitbucket and Azure DevOps on the roadmap behind the same
          abstraction. Same engine, same gate semantics, every platform.
        </p>
      </>
    ),
    status: <span className="font-mono text-xs text-gate">quality parity, not a port</span>,
  },
  {
    number: "05",
    title: "Self-hosted that works on the first run — including Ollama",
    body: (
      <>
        <p>
          PR-Agent's self-hosted config silently fell back to OpenAI when
          pointed at non-OpenAI models (issue #2083), and a v0.33 regression
          overwrote non-OpenAI API keys with dummy values. Bito charges a
          $5/seat surcharge for self-hosting. CodeRabbit gates it behind
          enterprise sales.
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
          triggers a fresh flood. Cursor BugBot shipped incremental review in
          June 2026; no other major tool has it.
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
      <p className="mt-6 max-w-2xl text-lg text-ink-soft">
        Every claim below is sourced from vendor pricing pages, public
        post-mortems, and independent benchmarks as of June 2026. Where a
        competitor is better, we say so: CodeRabbit has wider platform coverage
        today, Greptile's cross-file recall is genuinely strong, and Qodo leads
        the offline Martian benchmark. Here is where Postil is different.
      </p>

      <div className="mt-14 space-y-12">
        {wedges.map((w) => (
          <section key={w.number} className="rule grid gap-6 pt-10 md:grid-cols-[1fr_3fr]">
            <div>
              <p className="font-mono text-sm text-charcoal/40">{w.number}</p>
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
            Bitbucket and Azure DevOps support is roadmap, not shipped. If you
            are on either today, CodeRabbit or CodeAnt covers you now.
          </li>
          <li>
            No benchmark shows any tool catching more than about 65% of real
            bugs. Postil optimizes the precision of what it says, not the claim
            that it catches everything.
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
    </div>
  );
}
