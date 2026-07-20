import type { Metadata } from "next";
import Link from "next/link";

import { ConfidenceChart } from "@/components/confidence-chart";
import { Section } from "@/components/section";
import { StatusIcon } from "@/components/status-icon";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Webhook to queue to CLI to check-runs: the Postil hosted pipeline, configurable merge gate, minimal GitHub permissions, and retained review data.",
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "How Postil works",
    description:
      "A small, auditable pipeline around one review engine: webhook, queue, CLI, and check-runs.",
    url: "https://postil.dev/how-it-works",
    images: ["/opengraph-image"],
  },
};

const PIPELINE = [
  {
    step: "1",
    name: "Webhook",
    detail:
      "GitHub delivers a pull_request event. The signature is verified against the raw body before parsing; deliveries are deduped by id. Drafts and disabled repos are dropped here.",
  },
  {
    step: "2",
    name: "Queue",
    detail:
      "A review job lands in a Postgres-native queue (FOR UPDATE SKIP LOCKED). Webhooks can kick a bounded drain immediately, while the worker remains a slow fallback; retries use exponential backoff, and a watchdog reclaims anything stuck.",
  },
  {
    step: "3",
    name: "CLI",
    detail:
      "The worker mints a short-lived installation token, creates both check-runs, and shells out to the same pinned postil binary you can run locally. All review logic lives in the CLI.",
  },
  {
    step: "4",
    name: "Check-runs",
    detail:
      "The CLI posts inline comments in one batched review and completes postil/review. After the envelope is stored, the control plane completes postil/gate according to the organization’s merge-gate setting. The diff is not stored.",
  },
] as const;

export default function HowItWorksPage() {
  return (
    <div>
      <div className="mx-auto max-w-6xl px-6 pt-16 md:pt-20">
        <p className="eyebrow">How it works</p>
        <h1 className="serif-display mt-4 max-w-3xl text-4xl md:text-5xl">
          A small, auditable pipeline around one review engine.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-soft">
          The hosted control plane does four things: receive webhooks, queue
          jobs, run the CLI, and store the result. Everything that decides what
          to say about your code is in the open-source binary. The same pipeline
          answers <code className="font-mono text-base">@postil</code> mentions
          on PRs and issues (GitHub only): it reviews and answers only, and
          never opens PRs or pushes commits.
        </p>
      </div>

      {/* Pipeline diagram */}
      <div className="mx-auto max-w-6xl px-6 pt-14">
        <div className="grid gap-4 lg:grid-cols-4">
          {PIPELINE.map((stage, i) => (
            <div key={stage.step} className="relative">
              <div className="card h-full p-5">
                <p className="font-mono text-xs text-charcoal/70">
                  step {stage.step}
                </p>
                <p className="serif-display mt-1 text-xl">{stage.name}</p>
                <p className="mt-2 text-sm text-ink-soft">{stage.detail}</p>
              </div>
              {i < PIPELINE.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-1/2 -right-4 hidden -translate-y-1/2 font-mono text-lg text-gate lg:block"
                >
                  →
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="mt-4 font-mono text-xs text-charcoal/50">
          webhook → queue → CLI → check-runs. The worker owns the check-run ids
          from the start, so even a crashed review completes as failed instead
          of hanging in_progress.
        </p>
      </div>

      <Section
        number="01"
        eyebrow="Doctrine"
        title="Advisory by default. Blocking when enabled."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-4 text-ink-soft">
            <p>
              New organizations start with an advisory merge gate. An admin can
              enable blocking after adding <code className="font-mono text-sm">postil/gate</code>{" "}
              to the repository rules. Postil keeps the check neutral while the
              merge gate is advisory.
            </p>
            <p>
              With blocking enabled, invalid model output and incomplete hosted
              reviews fail closed. Turning blocking off reconciles the latest
              check for every pull request back to neutral.
            </p>
          </div>
          <div className="card p-6">
            <p className="eyebrow">Failure semantics</p>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-center gap-3">
                <StatusIcon kind="error" />
                <span>
                  <code className="font-mono">postil/gate</code> on operational
                  error: <strong>failure</strong> when blocking is enabled
                </span>
              </li>
              <li className="flex items-center gap-3">
                <StatusIcon kind="info" />
                <span>
                  <code className="font-mono">postil/review</code> on
                  operational error: neutral, with the error summary
                </span>
              </li>
              <li className="flex items-center gap-3">
                <StatusIcon kind="pass" />
                <span>Clean PR: both green, zero comments</span>
              </li>
              <li className="flex items-center gap-3">
                <StatusIcon kind="info" />
                <span>Advisory merge gate: neutral, with findings left on the review</span>
              </li>
            </ul>
          </div>
        </div>
      </Section>

      <Section
        number="02"
        eyebrow="Permissions"
        title="Minimal permissions: read your code, write your checks."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-charcoal text-left">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    Permission
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Level
                  </th>
                </tr>
              </thead>
              <tbody className="text-ink-soft">
                <tr className="border-b border-stone">
                  <td className="py-2 pr-4 font-mono text-xs">contents</td>
                  <td className="py-2">read</td>
                </tr>
                <tr className="border-b border-stone">
                  <td className="py-2 pr-4 font-mono text-xs">pull_requests</td>
                  <td className="py-2">write (review comments)</td>
                </tr>
                <tr className="border-b border-stone">
                  <td className="py-2 pr-4 font-mono text-xs">checks</td>
                  <td className="py-2">write (the two check-runs)</td>
                </tr>
                <tr className="border-b border-stone">
                  <td className="py-2 pr-4 font-mono text-xs">metadata</td>
                  <td className="py-2">read</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-mono text-xs">contents: write</td>
                  <td className="py-2 font-semibold text-rust">never requested</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="text-ink-soft">
            <p>
              In a{" "}
              <a
                href="https://research.kudelskisecurity.com/2025/08/19/how-we-exploited-coderabbit-from-a-simple-pr-to-rce-and-write-access-on-1m-repositories/"
                className="text-rust underline"
                rel="noopener"
              >
                publicly reported August 2025 disclosure
              </a>
              , security researchers described a remote-code-execution chain in
              the category leader&apos;s review pipeline that exposed
              installation credentials carrying <em>write</em> access across a
              large share of customer repositories. The lesson is structural: a
              reviewer does not need push access, so Postil&apos;s GitHub App
              never asks for it.
            </p>
            <p className="mt-4">
              Installation tokens are minted on demand from the App key, held
              in memory only, and expire within an hour. The App private key
              lives in your environment (or ours, hosted) and is never written
              to the database or logs.
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="data"
        number="03"
        eyebrow="Data"
        title="Only the review envelope is retained."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="text-ink-soft">
            <p>
              The control plane persists exactly one artifact per review: the
              envelope, a JSON document with the summary, findings (path,
              line, severity, confidence), token usage, and gate verdict. Your
              diff is fetched at review time, sent through either Postil&apos;s
              configured provider path or your BYOK provider path, and discarded
              with the process. CLI and self-hosted reviews send diffs directly
              to the endpoint you configure.
            </p>
            <p className="mt-4">
              Bring-your-own API keys are sealed with AES-256-GCM before they
              touch the database, and the settings form is write-only: a stored
              key can be replaced or removed, never read back out.
            </p>
          </div>
          <div className="card p-6">
            <p className="eyebrow">Stored per review</p>
            <div className="mt-4">
              <pre
                className="overflow-x-auto font-mono text-xs leading-relaxed text-ink-soft"
                tabIndex={0}
                aria-label="Code sample"
              >
                <code>{`{
  "summary": "Refund path missing idempotency key.",
  "silent": false,
  "findings": [
    {
      "path": "src/billing/invoice.ts",
      "line": 84,
      "severity": "error",
      "kind": "risk",
      "confidence": 0.91,
      "title": "Non-idempotent refund",
      "body": "Retried webhook double-credits."
    }
  ],
  "counts": { "info": 0, "warn": 0, "error": 1, "suppressed": 5 },
  "gate": { "failOn": "error", "failing": true },
  "usage": { "promptTokens": 8421, "completionTokens": 612 }
}`}</code>
              </pre>
            </div>
            <p className="mt-2 font-mono text-[10px] text-charcoal/70">
              Illustrative envelope.
            </p>
            <p className="mt-3 text-xs text-charcoal/50">
              The full schema is documented at{" "}
              <Link href="/docs/envelope" className="text-rust underline">
                /docs/envelope
              </Link>
              .
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="silence-methodology"
        number="04"
        eyebrow="Methodology"
        title="How the silence rate is computed."
      >
        <div className="grid gap-8 md:grid-cols-2">
          <div className="text-ink-soft">
            <p>
              The number on the homepage comes from replaying the released CLI
              against a fixed sample of <strong>126</strong> recently merged
              public pull requests (around 18 repos across JS/TS, Python, Go,
              and Rust) and reading the envelope each review produced. Nothing
              is hand-labeled after the fact.
            </p>
            <p className="mt-4">
              A PR counts as <strong>silent</strong> when its envelope has
              zero findings <em>and</em> the run posted zero PR comments (the
              same condition <code className="font-mono text-sm">postil/review</code>{" "}
              uses to decide whether to comment at all). The{" "}
              <strong>silence rate</strong> is silent ÷ 126.
            </p>
            <p className="mt-4">
              The chart to the right (the same one shown on the{" "}
              <Link href="/#silence-rate" className="text-rust underline">
                homepage
              </Link>
              ) only plots the <em>non-silent</em> runs: each shipped
              finding&apos;s confidence is sorted into the envelope&apos;s{" "}
              <code className="font-mono text-sm">confidenceBuckets</code>{" "}
              (five buckets of width 0.2, 0.0–1.0), then summed across all 126
              envelopes. It is a count of findings, not PRs: one PR can
              contribute more than one point.
            </p>
          </div>
          <figure className="card p-6">
            <ConfidenceChart size="sm" />
          </figure>
          <div className="card p-6 md:col-span-2">
            <p className="eyebrow">Per-PR envelope fields used</p>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-start gap-3">
                <span className="font-mono text-gate">→</span>
                <span>
                  <code className="font-mono text-xs">findings.length === 0</code>{" "}
                  and 0 comments posted → counts toward the silent numerator
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="font-mono text-gate">→</span>
                <span>
                  <code className="font-mono text-xs">confidenceBuckets</code>{" "}
                  from every non-silent envelope, summed → the point values
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="font-mono text-gate">→</span>
                <span>n = 126 is the full sample: every PR in
                  the run contributes to the denominator</span>
              </li>
            </ul>
            <p className="mt-4 text-xs text-charcoal/50">
              Raw envelopes and the run log are kept privately; the aggregate
              figures on this site are not hand-tuned between runs. See{" "}
              <Link href="/why-postil" className="text-rust underline">
                Why Postil
              </Link>{" "}
              for how this compares to what incumbents publish.
            </p>
          </div>
        </div>
      </Section>

      <div className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rule flex flex-wrap items-center justify-between gap-6 pt-8">
          <p className="serif-display text-2xl">
            Four pipeline steps produce one stored envelope.
          </p>
          <div className="flex gap-4">
            <Link href="/install" className="btn-primary">
              Install Postil
            </Link>
            <Link href="/docs/self-hosted" className="btn-secondary">
              Self-host it
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
