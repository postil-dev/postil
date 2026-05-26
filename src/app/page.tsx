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
    file: "src/billing/checkout.ts:42",
    title: "Checkout can double-apply account credits",
    body: "The diff applies credits before tax and again during finalization. This can undercharge paid invoices, so the branch should not merge until one path owns the credit calculation.",
    patch: "- total -= credit.amount\n+ total = applyAccountCreditOnce(total, credit)",
  },
  {
    severity: "watch",
    file: "infra/queue-policy.yaml:18",
    title: "Retry window widens without an idempotency guard",
    body: "The worker now retries for longer than the payment provider's request cache. Ask an accountable human to approve the operational risk or add a durable idempotency key.",
    patch: "+ idempotencyKey: checkout.intentId",
  },
  {
    severity: "note",
    file: ".postil.yaml:12",
    title: "Repeated migration rule is enforceable",
    body: "The same migration-review feedback has appeared three times. Move it into a repo policy so future reviews can stay silent unless the check fails.",
    patch: '+ requireHumanReview:\n+   - "drizzle/**/*.sql"',
  },
];

const pipelineRows = [
  ["diff parsed", "38 files", "1.8s"],
  ["context loaded", "12 call sites", "4.1s"],
  ["guardrails checked", "4 repo rules", "0.7s"],
  ["merge signal", "3 findings", "18.4s"],
];

const capabilities = [
  {
    label: "Correctness",
    title: "Finds context-dependent regressions.",
    body: "Postil follows imports, call sites, tests, and configuration before it decides a change is merge-relevant.",
  },
  {
    label: "Security",
    title: "Escalates security and data exposure.",
    body: "Findings explain the concrete risk, the affected path, and the review decision needed before merge.",
  },
  {
    label: "Human escalation",
    title: "Marks consequential decisions for owners.",
    body: "Architecture, permissions, billing, migrations, storage, and infrastructure changes get routed to accountable humans.",
  },
  {
    label: "Repository memory",
    title: "Turns repeated findings into guardrails.",
    body: "When feedback becomes objective and recurring, Postil suggests a lint, test, CI check, hook, or repo policy.",
  },
];

const ruleSuggestions = [
  {
    source: "accepted feedback",
    rule: "Require one owner for account-credit math.",
    target: ".postil.yaml",
  },
  {
    source: "human escalation",
    rule: "Ask for owner review when payment retry policy changes.",
    target: ".github/workflows/review.yml",
  },
  {
    source: "noise control",
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
            href="https://github.com/postil-dev/postil-reviewer"
            className="hidden px-3 py-1.5 text-muted-foreground transition hover:text-foreground lg:block"
          >
            CLI
          </Link>
          <TrackedLink
            href="/install"
            cta="Install CLI"
            className={`${buttonVariants({ size: "sm" })} ml-2`}
          >
            Install CLI
          </TrackedLink>
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
        className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          role="img"
          aria-label="Postil logo"
        >
          <path
            d="M4 4L8 8L4 12"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
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
            Local-first review gate
          </span>
          <div className="space-y-5">
            <h1 className="font-display text-5xl leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
              Postil is the review gate for agent-speed development.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              Let agents write code. Do not let unchecked changes merge. Postil runs before push or
              merge, catches context-dependent risk, escalates consequential changes, and stays
              silent when it has nothing useful to say.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TrackedLink
              href="/install"
              cta="Install CLI"
              className={`${buttonVariants({ size: "lg" })} min-w-44 justify-center`}
            >
              Install the CLI
            </TrackedLink>
            <TrackedLink
              href="#console"
              cta="See merge signal"
              className={`${buttonVariants({ variant: "outline", size: "lg" })} min-w-44 justify-center text-foreground`}
            >
              See merge signal
            </TrackedLink>
          </div>
          <div className="mt-2 grid max-w-xl grid-cols-3 border border-border/70 bg-card/35">
            <Metric value="BYOK" label="local first" />
            <Metric value="0" label="clean comments" />
            <Metric value="merge" label="signal only" />
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
      <div className="mt-1 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </div>
    </div>
  );
}

function ReviewConsole() {
  return (
    <div
      id="console"
      className="border border-border bg-card/80 shadow-[0_24px_80px_-36px_rgba(0,0,0,0.9)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/50 px-4 py-3 font-mono text-xs text-muted-foreground">
        <span>postil review / checkout-risk #418</span>
        <span className="text-chart-2">needs accountable review</span>
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
          <div className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
            Decision evidence
          </div>
          <div className="mt-4 space-y-4">
            <Decision
              label="Why comment"
              value="Touches billing math and retry policy in the same branch. Both can change customer-visible outcomes."
            />
            <Decision
              label="Action"
              value="Block merge until credit calculation has one owner and payment retry risk is explicitly accepted."
            />
            <Decision
              label="Suppressed"
              value="12 formatting, import-order, and generic summary notes left to existing guardrails or omitted."
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
      <div className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </div>
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
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Review by default, trust by evidence.
          </h2>
        </div>
        <div className="grid gap-px border border-border bg-border/70 sm:grid-cols-4">
          {pipelineRows.map(([name, result, time]) => (
            <div key={name} className="bg-card p-5">
              <div className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
                {name}
              </div>
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
          <span className="font-mono text-xs tracking-widest text-primary uppercase">
            What it reviews
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Built for the parts of review that fail when code moves at agent speed.
          </h2>
        </div>
        <div className="grid gap-px border border-border bg-border/70 md:grid-cols-2">
          {capabilities.map((item) => (
            <article key={item.label} className="bg-background p-6">
              <div className="font-mono text-[11px] tracking-widest text-primary uppercase">
                {item.label}
              </div>
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
          <span className="font-mono text-xs tracking-widest text-primary uppercase">
            Human escalation
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Consequential changes should have accountable owners.
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
            Postil can identify routine findings, but it does not pretend to own business, security,
            architecture, cost, data, or infrastructure judgment.
          </p>
        </div>
        <div className="border border-border bg-card">
          <div className="border-b border-border px-4 py-3 font-mono text-xs text-muted-foreground">
            infra/queue-policy.yaml
          </div>
          <div className="space-y-3 p-4 font-mono text-xs">
            <Line tone="del" text="- retryWindow: 90s" />
            <Line tone="add" text="+ retryWindow: 20m" />
            <Line tone="add" text="+ deadLetterQueue: disabled" />
          </div>
          <div className="border-t border-border p-4">
            <div className="font-mono text-[11px] tracking-widest text-destructive uppercase">
              Escalate
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              The branch changes retry cost and failure behavior. Merge needs an owner who can
              accept the operational tradeoff.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Line({ tone, text }: { tone: "add" | "del"; text: string }) {
  return (
    <div
      className={
        tone === "add"
          ? "bg-diff-add px-3 py-1.5 text-chart-2"
          : "bg-diff-del px-3 py-1.5 text-destructive"
      }
    >
      {text}
    </div>
  );
}

function Rules() {
  return (
    <section className="border-b border-border/70 py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mb-10 max-w-3xl">
          <span className="font-mono text-xs tracking-widest text-primary uppercase">
            Proposed rules
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Repeated findings become repository policy.
          </h2>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Postil respects repository configuration, including .postil.yaml, .coderabbit.yaml, and
            .kodo.yaml. When the team repeatedly accepts the same objective finding, review feedback
            should become infrastructure.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {ruleSuggestions.map((item) => (
            <article key={item.rule} className="border border-border bg-card/60 p-5">
              <div className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
                {item.source}
              </div>
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
          <span className="font-mono text-xs tracking-widest text-primary uppercase">
            Local first
          </span>
          <h2 className="mt-3 font-display text-3xl leading-tight sm:text-4xl">
            Start with the BYOK CLI. Hosted review can come later.
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <PlanCard
            name="CLI"
            price="Free"
            sub="Apache-2.0, bring your own model key."
            bullets={[
              "Runs locally or in CI",
              "No dashboard required",
              "OpenRouter-compatible runtime",
              "Repo config via .postil.yaml",
            ]}
          />
          <PlanCard
            name="Hosted"
            price="Later"
            sub="Managed PR review after the local gate is right."
            bullets={[
              "GitHub App workflow",
              "Team policy memory",
              "Queue and usage controls",
              "Human escalation paths",
            ]}
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
    <article
      className={[
        "border p-6",
        featured ? "border-primary bg-card" : "border-border bg-card/50",
      ].join(" ")}
    >
      <div className="font-mono text-[11px] tracking-widest text-muted-foreground uppercase">
        {name}
      </div>
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
      <TrackedLink
        href="/install"
        cta="Install CLI"
        className={`${buttonVariants({ variant: featured ? "default" : "outline" })} mt-6 w-full`}
      >
        Install CLI
      </TrackedLink>
    </article>
  );
}

function SelfHostStrip() {
  return (
    <section className="border-b border-border/70 py-14">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <p className="max-w-3xl text-2xl font-semibold leading-snug">
          Apache-2.0 and runnable in CI. Use the local CLI today with your own model provider;
          hosted PR review stays subordinate to the review gate.
        </p>
        <div className="flex flex-wrap gap-3">
          <TrackedLink
            href="https://github.com/postil-dev/postil-reviewer"
            cta="View CLI source"
            className={buttonVariants({ variant: "outline" })}
          >
            View CLI source
          </TrackedLink>
          <TrackedLink href="/install" cta="Run locally" className={buttonVariants()}>
            Run locally
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
          <p className="max-w-sm text-xs leading-relaxed">
            Postil is a local-first review gate for agent-speed development. Source at
            postil-dev/postil-reviewer and postil-dev/postil, Apache-2.0.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-x-10 gap-y-2 text-xs sm:grid-cols-3">
          <TrackedLink href="/install" cta="Install CLI" className="hover:text-foreground">
            Set up
          </TrackedLink>
          <TrackedLink href="#pricing" cta="Pricing" className="hover:text-foreground">
            Pricing
          </TrackedLink>
          <Link
            href="https://github.com/postil-dev/postil-reviewer"
            className="hover:text-foreground"
          >
            CLI source
          </Link>
          <Link
            href="https://github.com/postil-dev/postil/security/advisories/new"
            className="hover:text-foreground"
          >
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
