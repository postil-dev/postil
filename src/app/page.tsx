import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="relative z-[1] flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
      <Hero />
      <ReviewDemo />
      <WhatItCatches />
      <HowItWorks />
      <Privacy />
      <Pricing />
      <SelfHostStrip />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2 font-medium tracking-tight">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="#features"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground sm:block"
          >
            Features
          </Link>
          <Link
            href="#pricing"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground sm:block"
          >
            Pricing
          </Link>
          <Link
            href="https://github.com/postil-dev/postil"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground sm:block"
          >
            Source on GitHub
          </Link>
          <Link
            href="/install"
            className={`${buttonVariants({ size: "sm" })} ml-2`}
          >
            Add the GitHub App
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground font-display text-base"
      >
        P
      </span>
      <span className="font-display text-lg">Postil</span>
    </span>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-20 lg:grid-cols-12 lg:gap-16 lg:py-28">
        <div className="flex flex-col justify-center gap-7 lg:col-span-7">
          <span className="anim-reveal inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card/40 px-3 py-1 font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Open-source · Apache-2.0
          </span>
          <h1 className="anim-reveal delay-1 font-display text-5xl leading-[1.02] tracking-tight sm:text-7xl">
            A reviewer that reads
            <br />
            <span className="italic text-muted-foreground">every</span>{" "}
            <span className="highlight-mark">pull request</span>,
            <br />
            skips the nits.
          </h1>
          <p className="anim-reveal delay-2 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Postil spins up on every new PR, reads the diff in context, and
            leaves inline comments on the things that matter.
            Correctness. Security. The bug you missed. No drive-by style gripes.
          </p>
          <div className="anim-reveal delay-3 flex flex-wrap items-center gap-3">
            <Link
              href="/install"
              className={buttonVariants({ size: "lg" })}
            >
              Add the GitHub App
            </Link>
            <Link
              href="#demo"
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              See a review
            </Link>
          </div>
          <p className="anim-reveal delay-4 font-mono text-xs text-muted-foreground">
            No charge during public beta · Hosted at postil.dev · <Link className="underline decoration-dotted underline-offset-4 hover:text-foreground" href="https://github.com/postil-dev/postil">source on GitHub</Link>
          </p>
        </div>
        <div className="anim-reveal-slow delay-3 lg:col-span-5">
          <HeroArtifact />
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-5">
        <div className="hairline" />
      </div>
    </section>
  );
}

/** Stylised PR review card for the hero — fake but specific. */
function HeroArtifact() {
  return (
    <div className="lift relative rounded-xl border border-border bg-card/70 p-4 font-mono text-[12.5px] shadow-[0_40px_80px_-30px_rgba(0,0,0,0.8)] backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between text-muted-foreground">
        <span className="truncate">acme-corp/project-alpha · PR #1</span>
        <span className="rounded-full bg-[color:var(--diff-add)] px-2 py-0.5 text-[10px] tracking-widest uppercase text-[#00D2AA]">
          reviewed
        </span>
      </div>
      <pre className="overflow-x-auto whitespace-pre leading-6 text-foreground/90">
{`  src/auth/session.ts                              +8 −3

-  const user = await db.query.users.findFirst({
-    where: eq(users.email, email),
-  });
+  const user = await db.query.users.findFirst({
+    where: eq(users.email, email.toLowerCase()),
+  });`}
      </pre>
      <div className="mt-4 rounded-lg border border-primary/40 bg-[color:var(--highlight)] p-3 leading-snug">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-sans tracking-widest uppercase text-primary">
          <span aria-hidden>●</span>
          <span>Postil · correctness</span>
        </div>
        <p className="font-sans text-[13px] text-foreground">
          <span className="typing">
            Emails were indexed case-insensitively but compared case-sensitively.
          </span>
        </p>
      </div>
    </div>
  );
}

function ReviewDemo() {
  return (
    <section id="demo" className="border-b border-border/50 py-20">
      <div className="mx-auto max-w-6xl px-5">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr] lg:items-center lg:gap-16">
          <div className="flex flex-col gap-4">
            <span className="font-mono text-xs tracking-widest text-primary-foreground uppercase">
              What a review looks like
            </span>
            <h2 className="font-display text-3xl leading-tight sm:text-4xl">
              Inline, on the lines that matter.
            </h2>
            <p className="text-muted-foreground">
              Postil doesn&apos;t dump a wall-of-text summary on your PR. It
              leaves targeted comments at the exact line, grouped by severity,
              with a short reason and a suggested patch where it has one.
            </p>
            <ul className="mt-2 grid gap-3 text-sm text-muted-foreground">
              <li className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                Threads resolve themselves as soon as the next push addresses them.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                Reviews are idempotent, deduped on webhook delivery id, and debounced on rapid force-pushes.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                Every finding links back to the diff hunk it was produced from.
              </li>
            </ul>
          </div>

          <div className="lift overflow-hidden rounded-xl border border-border bg-card/60">
            <div className="flex items-center justify-between border-b border-border bg-background/40 px-4 py-2 font-mono text-xs text-muted-foreground">
              <span>src/server/handler.ts</span>
              <span>main ← feat/retry</span>
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-6">
<span className="block bg-[color:var(--diff-del)] text-[#FF5A5A]">{`- return await fetch(url).then(r => r.json());`}</span>
<span className="block bg-[color:var(--diff-add)] text-[#00D2AA]">{`+ const r = await fetch(url);`}</span>
<span className="block bg-[color:var(--diff-add)] text-[#00D2AA]">{`+ if (!r.ok) throw new ResponseError(r.status);`}</span>
<span className="block bg-[color:var(--diff-add)] text-[#00D2AA]">{`+ return await r.json();`}</span>
            </pre>
            <div className="border-t border-border bg-background/40 p-4">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] tracking-widest text-primary-foreground uppercase">
                <span>●</span> Postil · security
              </div>
              <p className="font-sans text-sm leading-snug text-foreground">
                The previous code silently returned a parsed 500-response. The
                replacement surfaces the HTTP failure before parsing. Also
                consider a retry budget for idempotent GETs.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function WhatItCatches() {
  const items = [
    {
      kind: "correctness",
      title: "Off-by-one, silent catches, case mismatches.",
      body: "Postil reads the diff in context of the surrounding code and flags the bug before a human has to.",
    },
    {
      kind: "security",
      title: "Missing auth checks, PII in logs, raw SQL.",
      body: "Security patterns get opinionated treatment with suggestions and the reason a reviewer might object.",
    },
    {
      kind: "scope",
      title: "Scope creep and accidental API changes.",
      body: "When a PR widens beyond its stated purpose or touches a public interface, Postil points it out so you can split or annotate.",
    },
    {
      kind: "config",
      title: "Your config, your rules.",
      body: "Postil honours .coderabbit.yaml, .kodo.yaml, and its own .postil.yaml. Team conventions override defaults.",
    },
    {
      kind: "noise",
      title: "No drive-by style gripes.",
      body: "Linting, formatting, and import ordering belong in your CI — not in the reviewer. Postil stays out of their way.",
    },
    {
      kind: "budget",
      title: "Predictable cost.",
      body: "One review per opened or ready-for-review PR, one per synchronize batch, capped tokens. No surprise bills.",
    },
  ];

  return (
    <section id="features" className="border-b border-border/50 py-24">
      <div className="mx-auto max-w-6xl px-5">
        <div className="mb-14 max-w-3xl">
          <span className="font-mono text-xs tracking-widest text-primary-foreground uppercase">
            Signal over noise
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            What Postil catches.
          </h2>
        </div>
        <div className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((f) => (
            <article key={f.kind} className="flex flex-col gap-3">
              <span className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
                {f.kind}
              </span>
              <h3 className="font-display text-2xl leading-snug">{f.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Add the GitHub App",
      body: "Add the Postil GitHub App to a repo or org. Takes a minute.",
    },
    {
      n: "02",
      title: "Open a PR",
      body: "Postil receives the webhook, reads the diff and the surrounding context, and works in a sandboxed worker.",
    },
    {
      n: "03",
      title: "Review lands",
      body: "Inline comments on the hunks that matter. Threads resolve as you address them.",
    },
  ];

  return (
    <section className="border-b border-border/50 py-24">
      <div className="mx-auto max-w-6xl px-5">
        <div className="mb-12 max-w-2xl">
          <span className="font-mono text-xs tracking-widest text-primary-foreground uppercase">
            Flow
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Three steps from setup to first review.
          </h2>
        </div>
        <ol className="grid gap-0 divide-y divide-border/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {steps.map((s) => (
            <li key={s.n} className="flex flex-col gap-4 p-8 sm:p-10">
              <span className="font-mono text-xs tracking-widest text-muted-foreground">{s.n}</span>
              <h3 className="font-display text-3xl">{s.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Privacy() {
  const items = [
    {
      k: "Your code stays yours",
      v: "Diffs are sent to the model provider only for the duration of a single review. No training, no retention on Postil servers, no resale.",
    },
    {
      k: "Short-lived credentials",
      v: "Reviews run with a per-installation GitHub token that expires in an hour. Sandboxes use fresh creds per run and are torn down after.",
    },
    {
      k: "EU-resident by default",
      v: "Database and analytics run in eu-central-1. You can pick the model region on OpenRouter to keep inference on-continent.",
    },
    {
      k: "Bring your own key",
      v: "Point Postil at your own OpenRouter, Anthropic, or OpenAI key and the diff never leaves your vendor relationship.",
    },
  ];

  return (
    <section className="border-b border-border/50 py-24">
      <div className="mx-auto max-w-6xl px-5">
        <div className="mb-12 max-w-2xl">
          <span className="font-mono text-xs tracking-widest text-primary-foreground uppercase">
            Privacy
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Your code is read once, then forgotten.
          </h2>
          <p className="mt-3 text-muted-foreground">
            Postil reviews code. It doesn&apos;t collect it, store it, or train on it.
          </p>
        </div>
        <div className="grid gap-px overflow-hidden rounded-xl bg-border/50 sm:grid-cols-2">
          {items.map((it) => (
            <div key={it.k} className="bg-background p-6">
              <h3 className="font-display text-xl">{it.k}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{it.v}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="border-b border-border/50 py-24">
      <div className="mx-auto max-w-6xl px-5">
        <div className="mb-12 max-w-2xl">
          <span className="font-mono text-xs tracking-widest text-primary-foreground uppercase">
            Pricing
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Pick the one that fits.
          </h2>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <PlanCard
            name="Hobby"
            price="Free"
            sub="No charge during public beta."
            bullets={[
              "All public repositories included",
              "Up to 3 private repos",
              "Managed at postil.dev",
              "Community support",
            ]}
            cta={{ label: "Add the GitHub App", href: "/install" }}
          />
          <PlanCard
            featured
            name="Team"
            price="$19"
            sub="per contributor / month"
            bullets={[
              "All private repositories included",
              "Org-wide install",
              "Priority review queue",
              "Email support within one business day",
            ]}
            cta={{ label: "Add the GitHub App", href: "/install" }}
          />
        </div>
        <p className="mt-8 text-sm text-muted-foreground">
          Prefer to run it yourself? Postil is Apache-2.0.{" "}
          <Link
            href="https://github.com/postil-dev/postil#self-host"
            className="underline decoration-dotted underline-offset-4 hover:text-foreground"
          >
            Self-host guide on GitHub →
          </Link>
        </p>
      </div>
    </section>
  );
}

function PlanCard({
  name,
  price,
  sub,
  bullets,
  cta,
  featured,
  muted,
}: {
  name: string;
  price: string;
  sub: string;
  bullets: string[];
  cta: { label: string; href: string };
  featured?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={[
        "relative flex flex-col gap-5 rounded-xl border p-7",
        featured
          ? "border-primary/60 bg-card/80 shadow-[0_20px_60px_-30px_#5C4DFF59]"
          : "border-border bg-card/40",
        muted ? "opacity-95" : "",
      ].join(" ")}
    >
      {featured ? (
        <span className="absolute -top-3 left-6 rounded-full border border-primary/50 bg-background px-2.5 py-0.5 font-mono text-[10px] tracking-widest text-primary-foreground uppercase">
          most teams
        </span>
      ) : null}
      <div>
        <h3 className="font-display text-2xl">{name}</h3>
        <div className="mt-1 font-display text-4xl tracking-tight">{price}</div>
        <div className="mt-1 text-sm text-muted-foreground">{sub}</div>
      </div>
      <ul className="grid gap-2 text-sm">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-3">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
            <span className="text-foreground/90">{b}</span>
          </li>
        ))}
      </ul>
      <Link
        href={cta.href}
        className={buttonVariants({
          size: "lg",
          variant: featured ? "default" : "outline",
        })}
      >
        {cta.label}
      </Link>
    </div>
  );
}

function SelfHostStrip() {
  return (
    <section className="border-b border-border/50 py-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-mono text-xs tracking-widest text-primary-foreground uppercase">
            Open-source, for keeps
          </span>
          <p className="mt-2 max-w-2xl font-display text-2xl leading-snug">
            Apache-2.0, source on GitHub.
            You can read, fork, self-host, or swap the reviewer model. Managed
            postil.dev is the same code, run by us.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            href="https://github.com/postil-dev/postil"
            className={buttonVariants({ variant: "outline" })}
          >
            View source on GitHub
          </Link>
          <Link
            href="https://github.com/postil-dev/postil#self-host"
            className={buttonVariants()}
          >
            Self-host guide on GitHub
          </Link>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-auto py-12 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-5 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-4">
          <Wordmark />
          <p className="max-w-sm text-xs leading-relaxed">
            Postil is an open-source AI pull request reviewer. Managed at
            postil.dev. Source at postil-dev/postil, Apache-2.0.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-x-10 gap-y-2 text-xs sm:grid-cols-3">
          <Link href="/install" className="hover:text-foreground">Set up</Link>
          <Link href="#pricing" className="hover:text-foreground">Pricing</Link>
          <Link href="https://github.com/postil-dev/postil" className="hover:text-foreground">Source on GitHub</Link>
          <Link href="https://github.com/postil-dev/postil/security/advisories/new" className="hover:text-foreground">Report a vuln on GitHub</Link>
          <Link href="/.well-known/security.txt" className="hover:text-foreground">security.txt</Link>
          <span>© {new Date().getFullYear()} Postil</span>
        </nav>
      </div>
    </footer>
  );
}
