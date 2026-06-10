import Image from "next/image";
import Link from "next/link";

import { Code } from "@/components/code";
import { StatusLine } from "@/components/status-line";

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="container-page pt-16 pb-20 grid gap-12 md:grid-cols-[1.2fr_1fr] items-center">
        <div>
          <div className="chip mb-6">Calm review gate</div>
          <h1 className="font-serif text-5xl md:text-6xl font-medium leading-[1.1] tracking-tight">
            Trust the merge,
            <br />
            not the speed.
          </h1>
          <p className="mt-6 text-lg text-[color:var(--color-charcoal-soft)] max-w-prose">
            Postil looks for the pull-request bugs reviewers usually have to reconstruct by
            hand: moved auth checks, unsafe deletes, race windows, bad migrations. Clean
            change? No filler comment.
          </p>
          <div className="mt-8 flex gap-3">
            <Link href="/install" className="btn-primary">
              Install in 60 seconds
            </Link>
            <Link href="/how-it-works" className="btn-secondary">
              See how it works
            </Link>
          </div>
          <div className="mt-6 text-sm text-[color:var(--color-charcoal-soft)]">
            Apache-2.0 · Rust CLI · GitHub Action · Hosted beta
          </div>
        </div>
        <div className="relative">
          <Image
            src="/brand/postil-hero-gate-sketch.png"
            alt=""
            width={520}
            height={520}
            className="opacity-90"
            priority
          />
        </div>
      </section>

      {/* Doctrine */}
      <section className="container-page py-16">
        <h2 className="font-serif text-3xl mb-3">Fewer comments. Better reasons.</h2>
        <p className="text-[color:var(--color-charcoal-soft)] max-w-2xl mb-10">
          Most AI reviewers comment on everything. The signal drowns. After two weeks teams
          mute them. Postil is built on the opposite assumption: silence is a feature.
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <Doctrine title="Skips clean PRs">
            Default <code>onClean: skip</code>. The required <code>postil/review</code>{" "}
            check completes neutral. No approval-noise comment, no poem, no diagram.
          </Doctrine>
          <Doctrine title="Reads the thread">
            The CLI is the engine. The same Rust binary runs locally, in your Action, and
            in the hosted worker — so what you debug is what ships.
          </Doctrine>
          <Doctrine title="Names the risk">
            Every finding cites a path and a line that exists in the diff. Severity comes
            with a kind: <code>risk</code>, <code>humanEscalation</code>,{" "}
            <code>guardrail</code>, or <code>uncertainty</code>.
          </Doctrine>
          <Doctrine title="Runs in CI">
            One composite Action installs the CLI at a pinned commit and runs{" "}
            <code>postil review</code>. Mark the check Required and you have a real merge
            gate, not advisory comments dressed up as one.
          </Doctrine>
        </div>
      </section>

      {/* Status line */}
      <section className="container-page py-16">
        <h2 className="font-serif text-3xl mb-3">Compact signal, no counters.</h2>
        <p className="text-[color:var(--color-charcoal-soft)] max-w-2xl mb-8">
          Findings get inline review comments. Everything else gets one line.
        </p>
        <div className="panel-quiet p-6">
          <StatusLine variant="error">2 risks · 1 uncertainty</StatusLine>
          <StatusLine variant="warn">1 guardrail suggestion</StatusLine>
          <StatusLine variant="info">1 human-escalation</StatusLine>
          <StatusLine variant="pass">No merge-relevant findings.</StatusLine>
        </div>
      </section>

      {/* Examples */}
      <section className="container-page py-16">
        <h2 className="font-serif text-3xl mb-3">Different risks, same restraint.</h2>
        <p className="text-[color:var(--color-charcoal-soft)] max-w-2xl mb-8">
          Real findings from real reviews. Notice the absence of style nits.
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          <Example
            file="src/auth/session.ts:142"
            severity="error"
            kind="risk"
          >
            Token comparison uses <code>===</code> instead of a timing-safe comparator.
            This regresses the fix from PR #318 and reopens the auth-timing leak.
          </Example>
          <Example
            file="drizzle/0024_user_index.sql:7"
            severity="error"
            kind="humanEscalation"
          >
            <code>CREATE INDEX</code> without <code>CONCURRENTLY</code> on a 50M-row table
            will lock writes for the duration of the deploy. Needs SRE sign-off before
            merge.
          </Example>
          <Example
            file="src/billing/usage.ts:78"
            severity="warn"
            kind="guardrail"
          >
            Quantity is summed inside a <code>forEach</code> over an unindexed list. The
            same pattern showed up twice in the last month — worth a lint rule.
          </Example>
        </div>
      </section>

      {/* Wedges */}
      <section className="container-page py-16">
        <h2 className="font-serif text-3xl mb-3">What you do not pay for.</h2>
        <p className="text-[color:var(--color-charcoal-soft)] max-w-2xl mb-8">
          Other AI reviewers bundle inference into the seat price. Bills jump 25× when
          usage shifts. Postil charges only for orchestration.
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          <Wedge title="Bring your own key">
            Use your own OpenRouter, Anthropic, OpenAI, or self-hosted endpoint. We never
            mark up inference. Your LLM bill stays in your provider dashboard.
          </Wedge>
          <Wedge title="Silence rate, not comment count">
            Your dashboard shows how often Postil stayed quiet. Most tools brag about
            volume. We brag about restraint.
          </Wedge>
          <Wedge title="Hosted or self-hosted">
            <code>docker compose up</code> on day one. Same binary, same envelope, same
            doctrine. GitHub Enterprise Server welcome.
          </Wedge>
        </div>
      </section>

      {/* Hosted card */}
      <section className="container-page py-16">
        <div className="panel p-8 grid md:grid-cols-[2fr_1fr] gap-8 items-center">
          <div>
            <h2 className="font-serif text-3xl mb-3">Hosted beta is open.</h2>
            <p className="text-[color:var(--color-charcoal-soft)] max-w-prose">
              Managed beta stays free while installs open. Install the GitHub App, point
              it at a repo, and the next PR gets reviewed. You can also run the CLI in
              your own CI today.
            </p>
            <div className="mt-6 flex gap-3">
              <Link href="/install" className="btn-primary">
                Install the GitHub App
              </Link>
              <Link href="/docs" className="btn-secondary">
                Run the CLI
              </Link>
            </div>
          </div>
          <Code>{`# Local review (any repo)
brew install postil-dev/tap/postil
postil review --staged`}</Code>
        </div>
      </section>

      <section className="container-page py-16 text-center">
        <p className="font-serif text-2xl text-[color:var(--color-charcoal-soft)]">
          Trust the merge, not the speed.
        </p>
        <p className="mt-3 text-sm text-[color:var(--color-charcoal-soft)]">
          Join the hosted beta queue, or run the Postil CLI in your own CI.
        </p>
      </section>
    </>
  );
}

function Doctrine({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-6">
      <div className="font-serif text-xl font-medium mb-2">{title}</div>
      <p className="text-[color:var(--color-charcoal-soft)] leading-relaxed">{children}</p>
    </div>
  );
}

function Wedge({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel-quiet p-6">
      <div className="font-serif text-xl font-medium mb-2">{title}</div>
      <p className="text-[color:var(--color-charcoal-soft)] leading-relaxed text-sm">
        {children}
      </p>
    </div>
  );
}

function Example({
  file,
  severity,
  kind,
  children,
}: {
  file: string;
  severity: "error" | "warn" | "info";
  kind: string;
  children: React.ReactNode;
}) {
  const sevColor = {
    error: "text-[color:var(--color-error)]",
    warn: "text-[color:var(--color-warn)]",
    info: "text-[color:var(--color-info)]",
  }[severity];
  return (
    <div className="panel p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <code className="text-xs text-[color:var(--color-charcoal-soft)]">{file}</code>
        <div className="flex gap-2">
          <span className={`chip ${sevColor}`}>{severity}</span>
          <span className="chip">{kind}</span>
        </div>
      </div>
      <p className="text-sm leading-relaxed">{children}</p>
    </div>
  );
}
