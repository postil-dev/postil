import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { ConfidenceChart } from "@/components/confidence-chart";
import { PrMock } from "@/components/pr-mock";
import { Section } from "@/components/section";
import { StatusIcon } from "@/components/status-icon";
import { Terminal } from "@/components/terminal";
import { githubAppInstallUrl } from "@/lib/github-app";
import {
  BYOK_ACTIVE_AUTHOR_MONTHLY_USD,
  HOSTED_ACTIVE_AUTHOR_MONTHLY_USD,
} from "@/lib/pricing-policy";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Gate engraving: quiet background watermark, anchored to the right
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
              AI review that can
              <br />
              block a merge.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-ink-soft">
              Postil reviews every non-draft pull request in repositories you
              enable as a real CI check. It comments only when a finding could
              change the merge decision, and it stays silent on clean PRs.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <a href={githubAppInstallUrl()} className="btn-primary">
                Install the GitHub App
              </a>
              <Link href="/install" className="btn-secondary">
                Install the CLI
              </Link>
            </div>
            <p className="mt-6 font-mono text-xs text-charcoal/75">
              Apache-2.0 CLI · free on public repos · no self-host license cost
            </p>
          </div>
        </div>
      </section>

      {/* 01: The noise problem */}
      <Section
        number="01"
        eyebrow="The noise problem"
        title="Review noise makes trust harder."
      >
        <div className="grid gap-8 md:grid-cols-3">
          <div className="card p-6">
            <p className="serif-display text-4xl text-rust">36%</p>
            <p className="mt-3 text-sm text-ink-soft">
              of comments in an independent 28-PR audit of the category leader
              were noise or nitpicking: 15% rated useless, another 21% pure
              style nits.
            </p>
          </div>
          <div className="card p-6">
            <p className="serif-display text-4xl text-rust">30%</p>
            <p className="mt-3 text-sm text-ink-soft">
              of Greptile&apos;s comments were addressed by developers before it
              retuned its defaults, according to Greptile&apos;s published numbers.
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
          A Postil finding ships only when its evidence is grounded in the
          changed code or checked-out repository, clears a confidence threshold,
          and could change the merge decision. Everything below that bar stays
          silent, and the silence rate itself is measured and published on every
          dashboard.
        </p>
        <p className="mt-6 max-w-3xl font-mono text-[13px] leading-relaxed text-charcoal/75">
          Sources: the 28-PR audit is{" "}
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

      {/* 02: The gate */}
      <Section
        number="02"
        eyebrow="The gate"
        title="Two check-runs: one blocks, one advises."
      >
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="card flex items-start gap-4 p-5">
              <StatusIcon kind="error" size={22} className="mt-0.5" />
              <div>
                <p className="font-mono text-sm font-semibold">postil/gate</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Fails on gate-level findings (default: severity{" "}
                  <code className="font-mono text-xs">error</code>) and, when
                  merge enforcement is enabled, operational failures that
                  prevent a review verdict. Require it in branch protection and
                  nothing below the threshold can block a merge. New
                  organizations start in advisory mode, where operational
                  failures leave this gate neutral.
                </p>
              </div>
            </div>
            <div className="card flex items-start gap-4 p-5">
              <StatusIcon kind="warn" size={22} className="mt-0.5" />
              <div>
                <p className="font-mono text-sm font-semibold">postil/review</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Advisory findings as line comments, file comments, or review
                  summary entries: warnings, escalations to accountable
                  humans, guardrail candidates. Informative, never required.
                </p>
              </div>
            </div>
            <div className="card flex items-start gap-4 p-5">
              <StatusIcon kind="pass" size={22} className="mt-0.5" />
              <div>
                <p className="font-mono text-sm font-semibold">clean PR</p>
                <p className="mt-1 text-sm text-ink-soft">
                  Review and enforced gate green; advisory gate neutral. No
                  comment, no summary, no LGTM filler. The check-run is the
                  entire conversation.
                </p>
              </div>
            </div>
          </div>
          <div>
            <p className="text-ink-soft">
              A neutral grey check reads as not-failed, and critical findings
              merge right past it. Postil's gate is a real CI check with real
              semantics: it fails on what matters and passes on what doesn't,
              separately from advisory commentary.
            </p>
            <p className="mt-4 text-ink-soft">
              None of the reviewers on our{" "}
              <Link href="/why-postil" className="text-rust underline">
                comparison pages
              </Link>{" "}
              ships this exact separation; teams otherwise rebuild it from raw
              check statuses.
            </p>
            <p className="mt-6">
              <Link href="/docs/gate" className="link-arrow">
                Branch protection setup
              </Link>
            </p>
          </div>
        </div>
      </Section>

      {/* 02b: On the PR */}
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
              warranted, review feedback placed on lines, files, or the review
              summary. The gate fails on a finding it
              can stand behind (here a missing idempotency key on a refund
              path) while advisory commentary stays out of the blocking lane.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-ink-soft">
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                Every finding cites its evidence location and carries a
                confidence score you can threshold on.
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>
                <span>
                  Require <code className="font-mono text-xs">postil/gate</code>{" "}
                  in branch protection to make the verdict binding.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-gate">→</span>A clean PR shows a
                passing review check and an enforced gate that passes, or an
                advisory gate that remains neutral, with no comments.
              </li>
            </ul>
          </div>
        </div>
      </Section>

      {/* 04: Terminal demo */}
      <Section
        number="04"
        eyebrow="One engine everywhere"
        title="The same binary runs locally, in CI, and behind the hosted app."
      >
        <div className="grid gap-8 lg:grid-cols-[3fr_2fr]">
          <div>
            <Terminal title="postil/review · postil#275">
              <code>
                <span className="t-dim">repository</span>{"  "}postil-dev/postil{"\n"}
                <span className="t-dim">pull request</span>{"  "}#275{"\n"}
                <span className="t-dim">commit</span>{"       "}4d08309409e3{"\n"}
                <span className="t-dim">changes</span>{"      "}10 files, 1,438 added lines{"\n"}
                <span className="t-dim">model</span>{"        "}moonshotai/kimi-k2.6{"\n"}
                {"\n"}
                <span className="t-red">error</span>{"  "}drizzle/0001_org_indexes_and_constraints.sql:3{"\n"}
                {"  "}Add deduplication before unique index migration{"\n"}
                {"\n"}
                <span className="t-dim">1 finding</span>{"\n"}
                <span className="t-red">gate: failing (failOn: error)</span>
              </code>
            </Terminal>
            <p className="mt-3 font-mono text-xs text-charcoal/70">
              <a
                href="https://github.com/postil-dev/postil/runs/84687183194"
                className="text-rust underline"
                rel="noopener"
              >
                Source: GitHub check-run 84687183194
              </a>
            </p>
          </div>
          <div>
            <p className="text-ink-soft">
              <code className="font-mono text-sm">postil review</code> works on
              your staged changes, against any base ref, on a saved diff, or on
              a remote PR. The GitHub Action and hosted service use the same
              reviewer and envelope contract.
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
                Invalid model output becomes an explicit no-verdict result,
                never a clean review.
              </li>
            </ul>
          </div>
        </div>
      </Section>

      {/* 05: Silence dashboard teaser */}
      <Section
        id="silence-rate"
        number="05"
        eyebrow="Provable restraint"
        title="We measure how often we say nothing."
      >
        <div className="grid items-center gap-10 lg:grid-cols-2">
          {/*
            Measured numbers, not a mockup. Pooled across two recorded runs of
            the released v0.1.0 CLI over 126 recently merged public pull
            requests (~18 repos across JS/TS, Python, Go, Rust;
            deepseek-v4-pro; one run each), 2026-06-13. 79 of 126 were silent
            (62.7%, 95% Wilson CI 54-71%); the 57 findings it did ship fell in
            confidence buckets [0,0,0,23,34]. Aggregate methodology is public;
            raw envelopes and run logs are private measurement artifacts under
            ignored local paths. When a newer run supersedes this, replace
            silenceRate and buckets together from that run's aggregate; do not
            hand-tune.
          */}
          <figure className="card p-8">
            <div className="flex items-center justify-between">
              <p className="eyebrow">Silence rate</p>
              <span className="rounded-full border border-stone px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-charcoal/70">
                n = 126
              </span>
            </div>
            <div className="mt-4 flex items-end gap-3">
              <span className="serif-display text-6xl">63%</span>
              <span className="pb-2 text-sm text-charcoal/70">
                of recent public PRs reviewed in silence
              </span>
            </div>
            <div className="mt-8">
              <ConfidenceChart size="lg" />
            </div>
          </figure>
          <div>
            <p className="text-ink-soft">
              Every Postil dashboard leads with the silence rate: the share of
              pull requests where we had nothing merge-relevant to say and said
              nothing. Next to it, the confidence distribution of every finding
              we did ship.
            </p>
            <p className="mt-4 text-ink-soft">
              <a
                href="https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/"
                className="text-rust underline"
                rel="noopener"
              >
                GitHub published
              </a>{" "}
              a one-off category figure: Copilot code review stayed silent on
              roughly 29% of reviews. Postil makes this an ongoing
              per-organization dashboard metric.
            </p>
            <p className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
              <Link href="/how-it-works#silence-methodology" className="link-arrow">
                How the silence metric is computed
              </Link>
              <Link href="/why-postil" className="link-arrow">
                How other tools compare
              </Link>
            </p>
          </div>
        </div>
      </Section>

      {/* 06: Limits, stated plainly */}
      <Section
        number="06"
        eyebrow="Known limits"
        title="What Postil cannot do."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div className="card p-6">
            <p className="font-mono text-sm font-semibold text-charcoal">
              Repository search is claim-driven, not exhaustive.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Review starts at the changed lines and searches the checked-out
              repository when a claim depends on surrounding code. The search
              is bounded, so broad architectural or dynamic defects can still
              be missed.
            </p>
          </div>
          <div className="card p-6">
            <p className="font-mono text-sm font-semibold text-charcoal">
              It does not execute code.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Findings come from source analysis; nothing is compiled or run.
              Pair the gate with your test suite and type checker: it is a
              review layer on top of them, and it replaces neither.
            </p>
          </div>
          <div className="card p-6">
            <p className="font-mono text-sm font-semibold text-charcoal">
              An LLM can be talked into a plausible clean review.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              A sufficiently convincing diff, or a PR description written to
              steer the model, can produce a false pass. Confidence thresholds
              and the gate/advisory split reduce how often that matters, but
              they do not make the model unpersuadable. This limit belongs to
              the model family and applies to every LLM reviewer.
            </p>
          </div>
          <div className="card p-6">
            <p className="font-mono text-sm font-semibold text-charcoal">
              Ungrounded findings are not published.
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Every finding must ground to verifiable review evidence or it is
              dropped before you see it. Findings about the PR title or
              description, which have no source line of their own, ground
              against a reserved synthetic anchor, and a run whose findings
              were all dropped becomes an explicit no-verdict result rather
              than reading as a clean review. The hosted gate applies the
              organization&apos;s enforcement policy.
            </p>
          </div>
        </div>
      </Section>

      {/* 07 - Pricing teaser */}
      <Section
        number="07"
        eyebrow="Pricing"
        title="Pricing follows active private-PR authors."
      >
        <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
          <div className="card p-6">
            <p className="serif-display text-2xl">Free</p>
            <p className="mt-2 text-sm text-ink-soft">
              Public-repository App reviews are free with your model provider.
              The local CLI is Apache-2.0.
            </p>
          </div>
          <div className="card border-gate p-6">
            <p className="serif-display text-2xl">
              BYOK ${BYOK_ACTIVE_AUTHOR_MONTHLY_USD} / author / mo
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Use your provider and models. Provider usage is billed directly
              to you.
            </p>
          </div>
          <div className="card p-6">
            <p className="serif-display text-2xl">
              Hosted ${HOSTED_ACTIVE_AUTHOR_MONTHLY_USD} / author / mo
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              Start with 30 days free and no card. Unlimited reviews.
            </p>
          </div>
          <div className="card p-6">
            <p className="serif-display text-2xl">Self-hosted</p>
            <p className="mt-2 text-sm text-ink-soft">
              Apache-2.0 with no seat fees or license cost. One Compose file,
              with named-field configuration errors at startup.
            </p>
          </div>
        </div>
        <p className="mt-8 max-w-2xl text-ink-soft">
          An active author is a person, bot, or service identity whose private
          pull request Postil reviews that month. Repositories are not billed.
        </p>
        <p className="mt-6">
          <Link href="/pricing" className="link-arrow">
            See pricing
          </Link>
        </p>
      </Section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="rounded-card shadow-card flex flex-col items-start gap-6 bg-charcoal p-10 text-ivory md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="serif-display text-3xl">
              Put a real gate on your next PR.
            </h2>
            <p className="mt-2 max-w-xl text-sm text-ivory/70">
              Install the GitHub App with your model provider, or run the CLI
              on your next diff. If we have nothing to say, you will hear
              nothing.
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:shrink-0">
            <a href={githubAppInstallUrl()} className="btn-primary text-center">
              Install the GitHub App
            </a>
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
