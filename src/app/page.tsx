import Link from "next/link";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";

type ReviewSeverity = "blocker" | "watch" | "note";

type ReviewFinding = {
  severity: ReviewSeverity;
  file: string;
  title: string;
  body: string;
  patch: string;
};

const reviewFindings: ReviewFinding[] = [
  {
    severity: "blocker",
    file: "examples/demo-shop/cart-total.ts:42",
    title: "Demo cart doubles coupon savings",
    body: "In this fictional shop example, the new branch subtracts the same toy coupon before and after tax. The sample checkout total can go negative.",
    patch: "- total -= coupon.value\n+ total = applyCouponOnce(total, coupon)",
  },
  {
    severity: "watch",
    file: "examples/widget-lab/preview-flags.yaml:18",
    title: "Fictional preview flag ships with the demo build",
    body: "The sample config turns on a pretend beta banner for every example workspace. Keep the fixture scoped to the tutorial route.",
    patch: "- demoBanner: always\n+ demoBanner: tutorial-only",
  },
  {
    severity: "note",
    file: "examples/pixel-pets/retry-toy.ts:27",
    title: "Toy retry example never stops polling",
    body: "The demo loop keeps asking for a pretend sprite after the sample scene closes. Add a simple guard so the tutorial stays readable.",
    patch: "+ if (scene.closed) return",
  },
];

const pipelineRows = [
  ["diff parsed", "38 files", "1.8s"],
  ["context loaded", "12 call sites", "4.1s"],
  ["policy pass", "4 repo rules", "0.7s"],
  ["review posted", "3 threads", "18.4s"],
];

const capabilities = [
  {
    label: "Correctness",
    title: "Reads surrounding code before commenting.",
    body: "Postil follows imports, call sites, and test fixtures so it can flag behavior changes, not just suspicious lines.",
  },
  {
    label: "Security",
    title: "Treats auth, secrets, and data exposure as review-blocking.",
    body: "Inline comments include the exploit path, affected file, and the smallest patch when the fix is obvious.",
  },
  {
    label: "Infrastructure",
    title: "Reviews config drift beside application code.",
    body: "Terraform, Docker, workflow, and runtime config changes are reviewed with the same severity ladder as code.",
  },
  {
    label: "Repository memory",
    title: "Turns repeated findings into enforceable rules.",
    body: "When a pattern repeats, Postil proposes a lint, QA, or policy rule instead of posting the same comment forever.",
  },
];

const ruleSuggestions = [
  {
    source: "illustrative example",
    rule: "Prefer one coupon application path in demo checkout code.",
    target: ".postil.yaml",
  },
  {
    source: "sample rule idea",
    rule: "Ask for review when tutorial flags move from examples into app routes.",
    target: ".github/workflows/review.yml",
  },
  {
    source: "noise-control example",
    rule: "Ignore generated SQL snapshots unless a migration file changes with them.",
    target: ".postil.yaml",
  },
];

export default function Home() {
  return (
    <div className="relative z-[1] flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <PipelineMetrics />
        <Capabilities />
        <InfrastructureScan />
        <Rules />
        <Pricing />
        <SelfHostStrip />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/86 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-medium tracking-tight">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            href="#capabilities"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground md:block"
          >
            Capabilities
          </Link>
          <TrackedLink
            href="#pricing"
            cta="Pricing"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground sm:block"
          >
            Pricing
          </TrackedLink>
          <Link
            href="https://github.com/postil-dev/postil"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground lg:block"
          >
            Source
          </Link>
          <TrackedLink href="/install" cta="Install on GitHub" className={`${buttonVariants({ size: "sm" })} ml-2`}>
            Install
          </TrackedLink>
        </nav>
      </div>
    </header>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" role="img" aria-label="Postil logo">
          <path d="M4 4L8 8L4 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
          <path d="M9 12H12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
        </svg>
      </span>
      <span className="font-display text-lg tracking-tight">Postil</span>
    </span>
  );
}

function Hero() {
  return (
    <section className="relative min-h-[calc(100vh-3.5rem)] overflow-hidden border-b border-border/70">
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 sm:px-6 sm:py-14 lg:grid-cols-[0.86fr_1.14fr] lg:items-center lg:py-16">
        <div className="flex flex-col justify-center gap-6">
          <span className="inline-flex w-fit items-center gap-2 border border-border bg-card/60 px-3 py-1 font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
            <span className="h-1.5 w-1.5 bg-chart-2" />
            Installable PR reviewer
          </span>
          <div className="space-y-5">
            <h1 className="font-display text-5xl leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
              Postil reviews pull requests like a senior maintainer.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              Add it to a repository and every PR gets a focused review for correctness, security, infrastructure, and repeated failure patterns. Inline findings include files, severity, reasoning, and suggested patches.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TrackedLink href="/install" cta="Install on GitHub" className={`${buttonVariants({ size: "lg" })} min-w-44 justify-center`}>
              Add the GitHub App
            </TrackedLink>
            <TrackedLink
              href="#console"
              cta="See review console"
              className={`${buttonVariants({ variant: "outline", size: "lg" })} min-w-44 justify-center text-foreground`}
            >
              See the console
            </TrackedLink>
          </div>
          <div className="mt-2 grid max-w-xl grid-cols-3 border border-border/70 bg-card/35">
            <Metric value="18s" label="median review" />
            <Metric value="3" label="findings" />
            <Metric value="0" label="style nits" />
          </div>
        </div>
        <ReviewConsole />
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-r border-border/70 p-4 last:border-r-0">
      <div className="font-mono text-2xl text-foreground">{value}</div>
      <div className="mt-1 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">{label}</div>
    </div>
  );
}

function ReviewConsole() {
  return (
    <div id="console" className="border border-border bg-card/80 shadow-[0_24px_80px_-36px_rgba(0,0,0,0.9)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/50 px-4 py-3 font-mono text-xs text-muted-foreground">
        <span>review / demo-repo #418</span>
        <span className="text-chart-2">ready for changes</span>
      </div>
      <div className="grid gap-px bg-border/70 lg:grid-cols-[1fr_0.75fr]">
        <div className="bg-card">
          {reviewFindings.map((finding) => (
            <article key={finding.file} className="border-b border-border/70 p-4 last:border-b-0">
              <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[11px] tracking-widest uppercase">
                <span className={severityClass(finding.severity)}>{finding.severity}</span>
                <span className="text-muted-foreground">{finding.file}</span>
              </div>
              <h2 className="text-base font-semibold">{finding.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{finding.body}</p>
              <pre className="mt-3 overflow-x-auto border border-border/70 bg-background/80 p-3 font-mono text-[11.5px] leading-5 text-foreground/85">
                {finding.patch}
              </pre>
            </article>
          ))}
        </div>
        <aside className="bg-background/70 p-4">
          <div className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">Decision evidence</div>
          <div className="mt-4 space-y-4">
            <Decision
              label="Why comment"
              value="Touches a toy checkout calculation, a tutorial flag, and a sample retry loop in the same demo PR."
            />
            <Decision
              label="Action"
              value="Request changes until the fictional examples match the tutorial behavior they describe."
            />
            <Decision
              label="Suppressed"
              value="12 formatting and import-order notes left to existing CI checks."
            />
          </div>
          <div className="mt-6 border border-border/70 bg-card/60 p-3">
            <div className="font-mono text-[11px] text-chart-2">checks</div>
            <div className="mt-3 space-y-2 font-mono text-xs text-muted-foreground">
              {pipelineRows.map(([name, result, time]) => (
                <div key={name} className="flex items-center justify-between gap-3">
                  <span>{name}</span>
                  <span className="text-foreground">{result}</span>
                  <span>{time}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function severityClass(severity: ReviewSeverity) {
  if (severity === "blocker") {
    return "border border-destructive/60 bg-destructive/15 px-2 py-0.5 text-destructive";
  }
  if (severity === "watch") {
    return "border border-accent/60 bg-accent/15 px-2 py-0.5 text-accent";
  }
  return "border border-chart-2/50 bg-chart-2/10 px-2 py-0.5 text-chart-2";
}

function Decision({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-primary pl-3">
      <div className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">{label}</div>
      <p className="mt-1 text-sm leading-6 text-foreground/90">{value}</p>
    </div>
  );
}

function PipelineMetrics() {
  return (
    <section className="border-b border-border/70 py-16">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.78fr_1.22fr]">
        <div>
          <span className="font-mono text-xs tracking-widest text-primary uppercase">Pipeline</span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">A review run you can audit.</h2>
        </div>
        <div className="grid gap-px border border-border bg-border/70 sm:grid-cols-4">
          {pipelineRows.map(([name, result, time]) => (
            <div key={name} className="bg-card p-5">
              <div className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">{name}</div>
              <div className="mt-4 text-2xl font-semibold">{result}</div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{time}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Capabilities() {
  return (
    <section id="capabilities" className="border-b border-border/70 py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-10 max-w-3xl">
          <span className="font-mono text-xs tracking-widest text-primary uppercase">What it reviews</span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Built for the parts of PR review that teams cannot delegate to formatters.
          </h2>
        </div>
        <div className="grid gap-px border border-border bg-border/70 md:grid-cols-2">
          {capabilities.map((item) => (
            <article key={item.label} className="bg-background p-6">
              <div className="font-mono text-[11px] tracking-widest text-primary uppercase">{item.label}</div>
              <h3 className="mt-4 text-2xl font-semibold">{item.title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function InfrastructureScan() {
  return (
    <section className="border-b border-border/70 py-20">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
        <div>
          <span className="font-mono text-xs tracking-widest text-primary uppercase">Infra scan</span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">Infrastructure changes get reviewed with product risk attached.</h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
            Postil connects configuration edits to the application behavior they describe: sample flags, cache policy, queue leases, and deployment workflows.
          </p>
        </div>
        <div className="border border-border bg-card">
          <div className="border-b border-border px-4 py-3 font-mono text-xs text-muted-foreground">examples/widget-lab/preview-flags.yaml</div>
          <div className="space-y-3 p-4 font-mono text-xs">
            <Line tone="del" text="- demoBanner: tutorial-only" />
            <Line tone="add" text="+ demoBanner: always" />
            <Line tone="add" text="+ exampleMode: playful-fixture" />
          </div>
          <div className="border-t border-border p-4">
            <div className="font-mono text-[11px] tracking-widest text-destructive uppercase">Blocker</div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              The fictional tutorial flag moves from a single sample page to every demo workspace. Keep it scoped so the example stays clear.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Line({ tone, text }: { tone: "add" | "del"; text: string }) {
  return <div className={tone === "add" ? "bg-diff-add px-3 py-1.5 text-chart-2" : "bg-diff-del px-3 py-1.5 text-destructive"}>{text}</div>;
}

function Rules() {
  return (
    <section className="border-b border-border/70 py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-10 max-w-3xl">
          <span className="font-mono text-xs tracking-widest text-primary uppercase">Proposed rules</span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">Repeated findings become repository policy.</h2>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Postil respects repository configuration, including .postil.yaml, .coderabbit.yaml, and .kodo.yaml, then proposes rules when review evidence says the team should automate the pattern.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {ruleSuggestions.map((item) => (
            <article key={item.rule} className="border border-border bg-card/60 p-5">
              <div className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{item.source}</div>
              <h3 className="mt-4 text-xl font-semibold leading-snug">{item.rule}</h3>
              <div className="mt-5 font-mono text-xs text-chart-2">{item.target}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="border-b border-border/70 py-20">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <span className="font-mono text-xs tracking-widest text-primary uppercase">Pricing</span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">Install now, scale when the team depends on it.</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <PlanCard
            name="Hobby"
            price="Free"
            sub="No charge during public beta."
            bullets={["Public repositories", "Up to 3 private repos", "Managed review runtime", "Community support"]}
          />
          <PlanCard
            name="Team"
            price="$19"
            sub="per contributor / month"
            bullets={["Org-wide installation", "All private repositories", "Priority review queue", "Email support"]}
            featured
          />
        </div>
      </div>
    </section>
  );
}

function PlanCard({
  name,
  price,
  sub,
  bullets,
  featured,
}: {
  name: string;
  price: string;
  sub: string;
  bullets: string[];
  featured?: boolean;
}) {
  return (
    <article className={["border p-6", featured ? "border-primary bg-card" : "border-border bg-card/50"].join(" ")}>
      <div className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">{name}</div>
      <div className="mt-4 text-4xl font-semibold tracking-tight">{price}</div>
      <div className="mt-1 text-sm text-muted-foreground">{sub}</div>
      <ul className="mt-6 space-y-2 text-sm">
        {bullets.map((bullet) => (
          <li key={bullet} className="flex gap-3">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 bg-primary" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      <TrackedLink href="/install" cta="Install on GitHub" className={`${buttonVariants({ variant: featured ? "default" : "outline" })} mt-6 w-full`}>
        Add the GitHub App
      </TrackedLink>
    </article>
  );
}

function SelfHostStrip() {
  return (
    <section className="border-b border-border/70 py-14">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <p className="max-w-3xl text-2xl font-semibold leading-snug">
          Apache-2.0 and runnable in CI. Use the managed install, or self-host the same reviewer with your own model provider.
        </p>
        <div className="flex flex-wrap gap-3">
          <TrackedLink href="https://github.com/postil-dev/postil" cta="View source" className={buttonVariants({ variant: "outline" })}>
            View source
          </TrackedLink>
          <TrackedLink href="https://github.com/postil-dev/postil#self-host" cta="Self-host" className={buttonVariants()}>
            Self-host
          </TrackedLink>
        </div>
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-auto py-10 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-4 sm:px-6 md:flex-row md:items-end">
        <div className="flex flex-col gap-4">
          <Wordmark />
          <p className="max-w-sm text-xs leading-relaxed">Postil is an open-source AI pull request reviewer. Managed at postil.dev. Source at postil-dev/postil, Apache-2.0.</p>
        </div>
        <nav className="grid grid-cols-2 gap-x-10 gap-y-2 text-xs sm:grid-cols-3">
          <TrackedLink href="/install" cta="Install on GitHub" className="hover:text-foreground">
            Set up
          </TrackedLink>
          <TrackedLink href="#pricing" cta="Pricing" className="hover:text-foreground">
            Pricing
          </TrackedLink>
          <Link href="https://github.com/postil-dev/postil" className="hover:text-foreground">
            Source
          </Link>
          <Link href="https://github.com/postil-dev/postil/security/advisories/new" className="hover:text-foreground">
            Report a vulnerability
          </Link>
          <Link href="/.well-known/security.txt" className="hover:text-foreground">
            security.txt
          </Link>
          <span>© {new Date().getFullYear()} Postil</span>
        </nav>
      </div>
    </footer>
  );
}
