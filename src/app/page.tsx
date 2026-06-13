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
      <section className="relative overflow-hidden">
        {/* Gate engraving — quiet background watermark, anchored to the right
            edge and held to the hero band. mix-blend-multiply drops the
            sketch's near-white ground onto the ivory page so only the pencil
            lines remain; the gradient mask fades the engraving out under the
            text so the copy keeps a clean, high-contrast ground. Hidden below
            sm so the mobile hero stays text-only and free of overflow. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 top-0 -z-10 hidden h-full w-[72%] select-none sm:block lg:w-[56%]"
        >
          <Image
            src="/brand/postil-hero-gate-sketch.png"
            alt=""
            fill
            priority
            draggable={false}
            sizes="(min-width: 1024px) 56vw, 72vw"
            className="object-contain object-right opacity-30 mix-blend-multiply [mask-image:linear-gradient(to_right,transparent,black_42%)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_42%)]"
          />
        </div>

        <div className="relative mx-auto w-full max-w-6xl px-6 pt-16 pb-20 md:pt-24 md:pb-28">
          <div className="max-w-2xl">
            <p className="font-mono text-sm uppercase tracking-[0.16em] text-charcoal/80">
              A review gate for agent-speed development
            </p>
            <h1 className="serif-display mt-4 text-4xl md:text-[56px]">
              Trust the merge,
              <br />
              not the speed.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-ink-soft">
              AI code review that blocks bad merges. Postil reviews every pull
              request, comments only when it can affect the merge, and stays
              completely silent on clean PRs. We say less. What we say is
              right.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/install" className="btn-primary">
                Install the CLI
              </Link>
              <Link href="/docs" className="btn-secondary">
                Read the docs
              </Link>
            </div>
            <p className="mt-6 font-mono text-xs text-charcoal/75">
              Apache-2.0 CLI · free on public repos · self-hosted forever
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
        <p className="mt-6 max-w-3xl font-mono text-[13px] leading-relaxed text-charcoal/75">
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
          .
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
                <span>
                  Require <code className="font-mono text-xs">postil/gate</code>{" "}
                  in branch protection to make the verdict binding.
                </span>
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
              <span className="t-dim">reviewing 4 files, 212 added lines</span>
              {"\n"}
              <span className="t-dim">(model: deepseek/deepseek-v4-pro)</span>
              {"\n"}
              {"\n"}
              <span className="t-red">error</span>{"  "}src/billing/invoice.ts:84{"\n"}
              {"  "}Refund path skips idempotency key;{"\n"}
              {"  "}a retried webhook double-credits the{"\n"}
              {"  "}customer. (confidence 0.91, kind: risk){"\n"}
              {"\n"}
              <span className="t-rust">warn</span>{"   "}src/api/export.ts:31{"\n"}
              {"  "}Unbounded query feeds the CSV stream;{"\n"}
              {"  "}the new endpoint has no pagination or{"\n"}
              {"  "}row cap. (confidence 0.78, kind: risk){"\n"}
              {"\n"}
              <span className="t-dim">2 findings</span>
              {"\n"}
              <span className="t-dim">5 suppressed below confidence 0.6</span>
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
          {/*
            Measured numbers, not a mockup. Every figure below comes from a
            recorded run of the released v0.1.0 CLI over 40 recently merged
            public pull requests (8 repos across JS/TS, Python, Go, Rust;
            deepseek-v4-pro; one run each), 2026-06-13. 26 of 40 were silent
            (65%); the 18 findings it did ship fell in confidence buckets
            [0,0,0,8,10]. Full methodology and raw envelopes are recorded
            privately in measurements/measurements-2026-06-13.md. When a newer
            run supersedes this, replace silenceRate and buckets together from
            that run's aggregate; do not hand-tune.
          */}
          <figure className="card p-8">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Silence rate</p>
              <span className="rounded-full border border-stone px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-charcoal/60">
                n = 40
              </span>
            </div>
            <div className="mt-4 flex items-end gap-3">
              <span className="serif-display text-6xl">65%</span>
              <span className="pb-2 text-sm text-charcoal/70">
                of recent public PRs reviewed in silence
              </span>
            </div>
            <div className="mt-8">
              <p className="font-mono text-xs text-charcoal/60">
                confidence of the findings it did ship
              </p>
              {(() => {
                const bars = [
                  { bucket: "0.0–0.2", count: 0 },
                  { bucket: "0.2–0.4", count: 0 },
                  { bucket: "0.4–0.6", count: 0 },
                  { bucket: "0.6–0.8", count: 8 },
                  { bucket: "0.8–1.0", count: 10 },
                ];
                const max = Math.max(...bars.map((b) => b.count));
                return (
                  <div
                    role="img"
                    aria-label={`Confidence of the 18 findings Postil shipped across 40 public pull requests: ${bars
                      .filter((b) => b.count > 0)
                      .map((b) => `${b.count} at ${b.bucket}`)
                      .join("; ")}. Every shipped finding was at 0.6 confidence or higher.`}
                  >
                    <div className="mt-3 flex h-24 items-end gap-2">
                      {bars.map((b, i) => (
                        <div
                          key={b.bucket}
                          className="flex-1 rounded-t-[3px] bg-gate"
                          style={{
                            height: `${max ? (b.count / max) * 100 : 0}%`,
                            opacity: 0.5 + i * 0.12,
                          }}
                        />
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
              Measured across 40 recently merged public pull requests, June 2026.
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
        <div className="rounded-card shadow-card flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="serif-display text-3xl">
              Review by default. Trust by evidence.
            </h2>
            <p className="mt-2 max-w-xl text-sm text-ivory/70">
              Install the GitHub App or run the CLI on your next diff. If we
              have nothing to say, you will hear nothing.
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
            <Link href="/install" className="btn-primary text-center">
              Install the CLI
            </Link>
            <Link
              href="/docs"
              className="inline-block rounded-card border border-ivory/40 px-5 py-2.5 text-center text-[15px] font-medium text-ivory transition-colors hover:bg-ivory/10"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
