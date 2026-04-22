import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader />
      <Hero />
      <HowItWorks />
      <Features />
      <SelfHostCallout />
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 flex h-14 w-full items-center border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-md bg-foreground text-background text-sm font-bold"
          >
            P
          </span>
          Postil
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          <Link
            href="https://github.com/postil-dev/postil"
            className="text-muted-foreground transition hover:text-foreground"
          >
            GitHub
          </Link>
          <Link
            href="/install"
            className={buttonVariants({ size: "sm" })}
          >
            Install
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:radial-gradient(60rem_35rem_at_50%_-10%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent)]"
      />
      <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-6 px-5 py-24 text-center">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Open-source · Apache-2.0
        </span>
        <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          AI pull request reviews that ship with the PR.
        </h1>
        <p className="max-w-xl text-balance text-muted-foreground">
          Postil runs a reviewer on every new PR. It reads the diff, flags
          correctness and security issues inline, and stays out of the way on
          drive-by stylistic nits.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/install" className={buttonVariants({ size: "lg" })}>
            Install the GitHub App
          </Link>
          <Link
            href="https://github.com/postil-dev/postil"
            className={buttonVariants({ variant: "outline", size: "lg" })}
          >
            View on GitHub
          </Link>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Open a PR",
      body: "Install the Postil GitHub App on a repo. On every opened or updated PR, Postil picks up the webhook.",
    },
    {
      n: "02",
      title: "Sandboxed review",
      body: "A short-lived Fly Machine clones the repo at the PR head and runs the reviewer against the diff.",
    },
    {
      n: "03",
      title: "Inline feedback",
      body: "Findings post back as review comments on the lines that matter. No noise, no drive-by nits.",
    },
  ];

  return (
    <section className="border-b border-border/60 py-20">
      <div className="mx-auto max-w-5xl px-5">
        <h2 className="mb-10 text-2xl font-semibold tracking-tight sm:text-3xl">
          How it works
        </h2>
        <ol className="grid gap-6 sm:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-6"
            >
              <span className="font-mono text-xs text-muted-foreground">{s.n}</span>
              <h3 className="text-lg font-medium">{s.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  const items = [
    {
      title: "Signal over noise",
      body: "Focuses on correctness, security, and obvious bugs. Style and formatting belong in your linter.",
    },
    {
      title: "Sandboxed by default",
      body: "Every review runs in an isolated VM with short-lived credentials. No reviewer state leaks between repos.",
    },
    {
      title: "Pluggable runtime",
      body: "Fly Machines by default; swap in E2B or a local Docker driver when self-hosting.",
    },
    {
      title: "Your model, your key",
      body: "OpenRouter by default with moonshotai/kimi-k2.6. Point at any provider your budget allows.",
    },
    {
      title: "Debounced synchronize",
      body: "Rapid force-pushes don't spin up one review per push; Postil waits until the PR settles.",
    },
    {
      title: "Fully auditable",
      body: "Delivery-id dedupe, signed webhooks, and a persisted review log in Postgres you can query.",
    },
  ];

  return (
    <section className="border-b border-border/60 py-20">
      <div className="mx-auto max-w-5xl px-5">
        <h2 className="mb-10 text-2xl font-semibold tracking-tight sm:text-3xl">
          What you get
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-border/70 bg-card p-5"
            >
              <h3 className="mb-2 text-base font-medium">{f.title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SelfHostCallout() {
  return (
    <section className="border-b border-border/60 py-20">
      <div className="mx-auto flex max-w-3xl flex-col items-start gap-5 px-5">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Or self-host the whole thing.
        </h2>
        <p className="text-muted-foreground">
          Apache-2.0. Next.js on Bun, Drizzle on Postgres, Trigger.dev for
          jobs. Swap the sandbox driver, point it at your model of choice,
          run it behind your own auth.
        </p>
        <pre className="w-full overflow-x-auto rounded-lg border border-border/70 bg-card px-4 py-3 text-sm font-mono leading-6">
          {`git clone https://github.com/postil-dev/postil
cd postil && bun install
cp .env.example .env.local
bun run dev`}
        </pre>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-auto py-10 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 sm:flex-row">
        <span>© {new Date().getFullYear()} Postil. Apache-2.0.</span>
        <nav className="flex items-center gap-5">
          <Link href="https://github.com/postil-dev/postil" className="hover:text-foreground">
            GitHub
          </Link>
          <Link
            href="https://github.com/postil-dev/postil/security/advisories/new"
            className="hover:text-foreground"
          >
            Report a vuln
          </Link>
          <Link href="/.well-known/security.txt" className="hover:text-foreground">
            security.txt
          </Link>
        </nav>
      </div>
    </footer>
  );
}
