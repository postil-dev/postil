import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { PrMock } from "@/components/pr-mock";
import { Section } from "@/components/section";
import { StatusIcon } from "@/components/status-icon";
import { Terminal } from "@/components/terminal";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-16 md:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[7fr_5fr]">
          <div>
            <p className="eyebrow">A review gate for agent-speed development</p>
            <h1 className="serif-display mt-4 text-4xl md:text-[56px]">
              Trust the merge,
              <br />
              not the speed.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-ink-soft">
              We say less. What we say is right. Postil reviews every pull
              request, comments only when it can affect the merge, and stays
              completely silent on clean PRs.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/install" className="btn-primary">
                Try the CLI
              </Link>
              <Link href="/docs" className="btn-secondary">
                Read the docs
              </Link>
            </div>
            <p className="mt-6 font-mono text-xs text-charcoal/65">
              Apache-2.0 CLI · free on public repos · self-hosted forever
            </p>
          </div>
          <div className="card overflow-hidden">
            <Image
              src="/brand/postil-hero-gate-sketch.png"
              alt="Architectural sketch of the Postil review gate"
              width={1831}
              height={859}
              priority
              className="h-auto w-full"
            />
            <p className="border-t border-stone px-4 py-3 font-mono text-xs text-charcoal/65">
              fig. 1 — the gate: every change passes through, few are stopped
            </p>
          </div>
        </div>
      </section>

      {/* 01 — The noise problem */}
      <Section
        number="01"
        eyebrow="The noise problem"
        title="AI review tools have a trust problem before they have a quality problem."
      >
        <div className="grid gap-8 md:grid-cols-3">
          <div className="card p-6">
            <p className="serif-display text-4xl text-rust">36%</p>
            <p className="mt-3 text-sm text-ink-soft">
              of comments in an independent 28-PR audit of the category leader
              were noise or nitpicking — 15% rated useless, another 21% pure
              style nits.
            </p>
          </div>
          <div className="card p-6">
            <p className="serif-display text-4xl text-rust">30%</p>
            <p className="mt-3 text-sm text-ink-soft">
              of a leading reviewer&apos;s comments were addressed by developers
              before it retuned its defaults — by its own published numbers.
              Most AI review comments change nothing.
            </p>
          </div>
          <div className="card p-6">
            <p className="serif-display text-4xl text-rust">571</p>
            <p className="mt-3 text-sm text-ink-soft">
              agent-driven pull requests one developer publicly documented
              pushing in 30 days. At that volume, every unnecessary comment is
              multiplied by hundreds.
            </p>
          </div>
        </div>
        <p className="mt-8 max-w-2xl text-ink-soft">
          Postil inverts the default. A finding ships only when it cites a diff
          location, clears a confidence threshold, and could change the merge
          decision. Everything else is silence — and silence is measured, not
          assumed.
        </p>
        <p className="mt-6 max-w-3xl font-mono text-xs leading-relaxed text-charcoal/60">
          Figures as of June 2026. Sources: the 28-PR audit is{" "}
          <a
            href="https://lycheeorg.dev/2025-09-13-code-rabbit/"
            className="text-rust underline"
            rel="noopener"
          >
            LycheeOrg&apos;s public review of CodeRabbit
          </a>
          ; the 30% comments-addressed figure is from{" "}
          <a
            href="https://www.greptile.com/blog/greptile-v4"
            className="text-rust underline"
            rel="noopener"
          >
            Greptile&apos;s v4 release notes
          </a>
          ; the 571-PR month is{" "}
          <a
            href="https://x.com/mg/status/2029751037716836478"
            className="text-rust underline"
            rel="noopener"
          >
            publicly documented
          </a>
          . See the sourced breakdown on{" "}
          <Link href="/why-postil" className="text-rust underline">
            Why Postil
          </Link>
          . Postil&apos;s own measured numbers will be published as they accrue;
          dashboard figures shown on this page are illustrative.
        </p>
      </Section>

      {/* 02 — The gate */}
      <Section
        number="02"
        eyebrow="The gate"
        title="Two check-runs. One blocks, one advises. Never conflated."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="card flex items-start gap-4 p-5">
              <StatusIcon kind="error" size={22} className="mt-0.5" />
              <div>
                <p className="font-mono text-sm font-semibold">postil/gate</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Fails only on gate-level findings (default: severity{" "}
                  <code className="font-mono text-xs">error</code>). Require it
                  in branch protection and nothing below the threshold can
                  block a merge. Fails closed on operational errors by default —
                  an unreviewed head is not a passing head. Repos can opt into{" "}
                  <code className="font-mono text-xs">gate.onError: advisory</code>{" "}
                  to fail open on provider outages only.
                </p>
              </div>
            </div>
            <div className="card flex items-start gap-4 p-5">
              <StatusIcon kind="warn" size={22} className="mt-0.5" />
              <div>
                <p className="font-mono text-sm font-semibold">postil/review</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Advisory findings as inline comments in a single batched
                  review: warnings, escalations to accountable humans,
                  guardrail candidates. Informative, never required.
                </p>
              </div>
            </div>
            <div className="card flex items-start gap-4 p-5">
              <StatusIcon kind="pass" size={22} className="mt-0.5" />
              <div>
                <p className="font-mono text-sm font-semibold">clean PR</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Both checks complete green. No comment, no summary poem, no
                  "LGTM" filler. The check-run is the entire conversation.
                </p>
              </div>
            </div>
          </div>
          <div>
            <p className="text-ink-soft">
              A grey, neutral check that "reads as didn't fail" is how a
              critical finding gets merged on a Friday. Postil's gate is a real
              CI check with real semantics: it fails on what matters and passes
              on what doesn't, separately from advisory commentary.
            </p>
            <p className="mt-4 text-ink-soft">
              No other mainstream reviewer ships this separation. Teams
              currently rebuild it by hand out of raw check statuses — or merge
              past advisory comments they have learned to ignore.
            </p>
            <p className="mt-6">
              <Link href="/docs/gate" className="link-arrow">
                Branch protection setup
              </Link>
            </p>
          </div>
        </div>
      </Section>

      {/* 02b — On the PR */}
      <Section
        number="03"
        eyebrow="On the pull request"
        title="What the two checks look like on a failing PR."
      >
        <div className="grid items-start gap-8 lg:grid-cols-[3fr_2fr]">
          <PrMock />
          <div>
            <p className="text-ink-soft">
              On GitHub, Postil shows up as exactly two check-runs plus, when
              warranted, batched inline comments. The gate fails on a finding it
              can stand behind — here a missing idempotency key on a refund path
              — while advisory commentary stays out of the blocking lane.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-ink-soft">
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                Every finding cites a file and line, and carries a confidence
                score you can threshold on.
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                Require <code className="font-mono text-xs">postil/gate</code> in
                branch protection to make the verdict binding.
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>A clean PR shows two
                green checks and no comments at all.
              </li>
            </ul>
          </div>
        </div>
      </Section>

      {/* 04 — Terminal demo */}
      <Section
        number="04"
        eyebrow="One engine everywhere"
        title="The same binary runs locally, in CI, and behind the hosted app."
      >
        <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
          <Terminal title="postil review --staged">
            <code>
              <span className="t-dim">$</span> postil review --staged{"\n"}
              {"\n"}
              <span className="t-dim">reviewing 4 files, 212 added lines (model: deepseek/deepseek-v4-pro)</span>
              {"\n"}
              {"\n"}
              <span className="t-red">error</span>{"  "}src/billing/invoice.ts:84{"\n"}
              {"  "}Refund path skips idempotency key; a retried webhook double-credits{"\n"}
              {"  "}the customer. (confidence 0.91, kind: risk){"\n"}
              {"\n"}
              <span className="t-rust">warn</span>{"   "}src/api/export.ts:31{"\n"}
              {"  "}Unbounded query feeds the CSV stream; the new endpoint has no{"\n"}
              {"  "}pagination or row cap. (confidence 0.78, kind: risk){"\n"}
              {"\n"}
              <span className="t-dim">2 findings · 5 suppressed below confidence 0.6</span>
              {"\n"}
              <span className="t-red">gate: failing (fail-on: error)</span>{"\n"}
              <span className="t-dim">exit 1</span>
            </code>
          </Terminal>
          <div>
            <p className="text-ink-soft">
              <code className="font-mono text-sm">postil review</code> works on
              your staged changes, against any base ref, on a saved diff, or on
              a remote PR. The GitHub Action and the hosted worker shell out to
              the same pinned binary — there is no second review engine to
              drift.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-ink-soft">
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                Exit codes carry the verdict: 0 clean, 1 gate-failing, 2
                operational error.
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                <span>
                  <code className="font-mono text-xs">--output-json</code>{" "}
                  emits the full envelope for tooling.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                Fails closed: ungrounded model output becomes a synthetic
                error finding, never a silent pass.
              </li>
            </ul>
          </div>
        </div>
      </Section>

      {/* 05 — Silence dashboard teaser */}
      <Section
        number="05"
        eyebrow="Provable restraint"
        title="Silence is a metric, not a hope."
      >
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <figure className="card p-8">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Silence dashboard</p>
              <span className="rounded-full border border-stone px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-charcoal/60">
                illustrative
              </span>
            </div>
            <div className="mt-4 flex items-end gap-3">
              <span className="serif-display text-6xl">68%</span>
              <span className="pb-2 text-sm text-charcoal/70">
                of PRs passed in silence{" "}
                <span className="text-charcoal/50">(illustrative)</span>
              </span>
            </div>
            <div className="mt-8">
              <p className="font-mono text-xs text-charcoal/60">
                confidence distribution of shipped findings
              </p>
              {(() => {
                const bars = [
                  { bucket: "0.0–0.2", value: 4 },
                  { bucket: "0.2–0.4", value: 7 },
                  { bucket: "0.4–0.6", value: 12 },
                  { bucket: "0.6–0.8", value: 38 },
                  { bucket: "0.8–1.0", value: 74 },
                ];
                return (
                  <div
                    role="img"
                    aria-label={`Confidence distribution of shipped findings (illustrative): ${bars
                      .map((b) => `${b.bucket} confidence, ${b.value} findings`)
                      .join("; ")}. Findings concentrate at high confidence.`}
                  >
                    <div className="mt-3 flex h-24 items-end gap-2">
                      {bars.map((b, i) => (
                        <div key={b.bucket} className="flex-1">
                          <div
                            className="w-full rounded-t-[3px] bg-gate"
                            style={{ height: `${b.value}%`, opacity: 0.5 + i * 0.12 }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex justify-between font-mono text-[10px] text-charcoal/55">
                      <span>0.0</span>
                      <span>0.2</span>
                      <span>0.4</span>
                      <span>0.6</span>
                      <span>0.8</span>
                      <span>1.0</span>
                    </div>
                  </div>
                );
              })()}
            </div>
            <figcaption className="mt-4 font-mono text-[11px] text-charcoal/55">
              Illustrative sample, not a live account.
            </figcaption>
          </figure>
          <div>
            <p className="text-ink-soft">
              Every Postil dashboard leads with the silence rate: the share of
              pull requests where we had nothing merge-relevant to say and said
              nothing. Next to it, the confidence distribution of every finding
              we did ship.
            </p>
            <p className="mt-4 text-ink-soft">
              If the bot is drifting noisy, you see it in a chart before your
              engineers feel it in their notifications. No incumbent surfaces
              this number; most would rather you didn't ask.
            </p>
            <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
              <Link href="/how-it-works#data" className="link-arrow">
                How the silence metric is computed
              </Link>
              <Link href="/why-postil" className="link-arrow">
                Why no incumbent shows it
              </Link>
            </p>
          </div>
        </div>
      </Section>

      {/* 06 — Pricing teaser */}
      <Section
        number="06"
        eyebrow="Pricing without meter anxiety"
        title="Flat $10 per developer. Inference on your own key, zero markup."
      >
        <div className="grid gap-8 md:grid-cols-3">
          <div className="card p-6">
            <p className="serif-display text-2xl">Free</p>
            <p className="mt-2 text-sm text-ink-soft">
              Public repos and the local CLI, forever. Apache-2.0.
            </p>
          </div>
          <div className="card border-gate p-6">
            <p className="serif-display text-2xl">$10 / dev / mo</p>
            <p className="mt-2 text-sm text-ink-soft">
              Flat orchestration. Bring your own OpenRouter, Anthropic, Azure,
              or Bedrock key — we pass inference through at provider rates.
              Hosted beta is currently free.
            </p>
          </div>
          <div className="card p-6">
            <p className="serif-display text-2xl">Self-hosted</p>
            <p className="mt-2 text-sm text-ink-soft">
              Free forever. Docker Compose that works on the first run,
              including with Ollama.
            </p>
          </div>
        </div>
        <p className="mt-8 max-w-2xl text-ink-soft">
          Your worst-case monthly bill is your seat count times ten dollars.
          Your LLM spend is visible in your provider's dashboard, not hidden in
          ours. No per-review surcharges, no credits, no billing shock at 10x
          PR volume.
        </p>
        <p className="mt-6">
          <Link href="/pricing" className="link-arrow">
            Run the cost calculator
          </Link>
        </p>
      </Section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="card flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="serif-display text-3xl">
              Review by default. Trust by evidence.
            </h2>
            <p className="mt-2 max-w-xl text-sm text-ivory/70">
              Install the GitHub App or run the CLI on your next diff. If we
              have nothing to say, you will hear nothing.
            </p>
          </div>
          <div className="flex shrink-0 gap-4">
            <Link href="/install" className="btn-primary">
              Try the CLI
            </Link>
            <Link
              href="/docs"
              className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
