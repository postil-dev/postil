"use client";

import { ArrowRight, CheckCircle2, GitBranch, Server, TestTubeDiagonal } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";
import {
  AnchorHeading,
  CtaStrip,
  DiffPreview,
  Eyebrow,
  PageFrame,
  proofPoints,
  StatusLine,
  StatusMark,
  type StatusKind,
  statusExamples,
} from "./site";

const AUTO_ADVANCE_MS = 1000;

type Example = {
  id: string;
  label: string;
  title: string;
  file: string;
  severity: StatusKind;
  status: StatusKind[];
  body: string;
  before: string;
  after: string;
};

const examples: Example[] = [
  {
    id: "billing",
    label: "Billing",
    title: "Plan mutation moved before authorization.",
    file: "src/billing/plan.ts:84",
    severity: "error",
    status: ["error"],
    body: "The write now happens before the permission check, so an unauthorized caller can change a plan and still receive an authorization error. Put the authorization gate before the mutation.",
    before:
      "await billing.updatePlan(org.id, plan)\nif (!canManageBilling(actor, org)) throw new Error('denied')",
    after:
      "if (!canManageBilling(actor, org)) throw new Error('denied')\nawait billing.updatePlan(org.id, plan)",
  },
  {
    id: "security",
    label: "Security",
    title: "Webhook signature is checked after parsing.",
    file: "src/api/webhooks.ts:31",
    severity: "error",
    status: ["error", "warn"],
    body: "Parsing untrusted JSON before signature verification lets malformed payloads spend CPU and reach error paths. Verify the raw body first, then parse.",
    before: "const payload = JSON.parse(body)\nverifySignature(body, signature)",
    after: "verifySignature(body, signature)\nconst payload = JSON.parse(body)",
  },
  {
    id: "ui",
    label: "UI",
    title: "The empty state now hides the primary action.",
    file: "src/app/projects/page.tsx:118",
    severity: "warn",
    status: ["warn"],
    body: "When the project list is empty, the branch returns before rendering the create button. New users lose the only obvious next action.",
    before: "if (!projects.length) return <EmptyState />",
    after: "if (!projects.length) return <EmptyState action={<CreateProject />} />",
  },
  {
    id: "race",
    label: "Race",
    title: "Two workers can claim the same queued job.",
    file: "src/jobs/queue.ts:52",
    severity: "error",
    status: ["error"],
    body: "The read and update are separate operations. Two workers can read the same pending row before either writes the claim. Use an atomic update or row lock.",
    before: "const job = await nextPendingJob()\nawait markRunning(job.id)",
    after: "const job = await claimNextPendingJob({ lock: true })",
  },
  {
    id: "migration",
    label: "Migration",
    title: "New non-null column has no backfill.",
    file: "drizzle/0042_accounts.sql:6",
    severity: "warn",
    status: ["warn", "info"],
    body: "Existing rows will fail the migration because `billing_email` is added as non-null without a default or staged backfill.",
    before: "ALTER TABLE accounts ADD COLUMN billing_email text NOT NULL;",
    after:
      "ALTER TABLE accounts ADD COLUMN billing_email text;\nUPDATE accounts SET billing_email = owner_email;\nALTER TABLE accounts ALTER COLUMN billing_email SET NOT NULL;",
  },
  {
    id: "cache",
    label: "Cache",
    title: "Permission changes do not invalidate the cache.",
    file: "src/auth/roles.ts:143",
    severity: "warn",
    status: ["warn"],
    body: "Role updates write to storage but leave the cached permission set alive, so revoked access can continue until TTL expiry.",
    before: "await roles.update(userId, nextRole)",
    after: "await roles.update(userId, nextRole)\nawait permissionCache.invalidate(userId)",
  },
  {
    id: "ci",
    label: "CI",
    title: "The release workflow runs on pull_request_target.",
    file: ".github/workflows/release.yml:3",
    severity: "error",
    status: ["error", "info"],
    body: "This workflow has publish credentials and now runs in a context that can be triggered by forked PRs. Keep release jobs on trusted push or manual dispatch events.",
    before: "on: pull_request_target",
    after: "on:\n  push:\n    branches: [main]\n  workflow_dispatch:",
  },
  {
    id: "deletion",
    label: "Deletion",
    title: "Bulk delete no longer scopes by organization.",
    file: "src/data/delete.ts:77",
    severity: "error",
    status: ["error"],
    body: "The organization predicate was removed from a destructive query. A user deleting one workspace can delete matching records in other organizations.",
    before: "where(eq(items.id, itemId))",
    after: "where(and(eq(items.id, itemId), eq(items.organizationId, orgId)))",
  },
  {
    id: "dependency",
    label: "Dependency",
    title: "Runtime dependency is loaded from user input.",
    file: "src/plugins/load.ts:19",
    severity: "warn",
    status: ["warn"],
    body: "The loader now imports a package name from request data. Restrict this to a server-owned allowlist before it reaches dynamic import.",
    before: "const plugin = await import(requestedPlugin)",
    after: "const plugin = await import(allowedPlugins[requestedPlugin])",
  },
  {
    id: "a11y",
    label: "A11y",
    title: "Dialog close control lost its accessible name.",
    file: "src/components/dialog.tsx:44",
    severity: "info",
    status: ["info"],
    body: "The icon-only close button no longer exposes a label. Screen reader users will hear an unnamed button in every modal.",
    before: "<button><XIcon /></button>",
    after: '<button aria-label="Close dialog"><XIcon /></button>',
  },
];

export default function Home() {
  return (
    <PageFrame>
      <section className="relative overflow-hidden border-b bg-background sm:min-h-[calc(100vh-4rem)]">
        <Image
          src="/brand/postil-hero-gate-sketch.png"
          alt=""
          width={1536}
          height={1024}
          priority
          className="pointer-events-none absolute inset-x-0 top-0 h-[30vh] w-full object-contain object-right-top sm:inset-0 sm:h-full sm:object-cover sm:object-center"
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[34vh] bg-gradient-to-b from-transparent via-background/12 to-background sm:inset-0 sm:h-auto sm:bg-[linear-gradient(90deg,#f7f5f1_0%,rgba(247,245,241,0.96)_22%,rgba(247,245,241,0.76)_46%,rgba(247,245,241,0.18)_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-40 bg-gradient-to-b from-transparent to-background sm:block" />
        <div className="relative z-10 mx-auto flex max-w-7xl items-start px-4 pb-14 pt-[28vh] sm:min-h-[calc(100vh-4rem)] sm:items-center sm:px-6 sm:py-14">
          <div className="max-w-3xl">
            <Eyebrow>Calm review gate</Eyebrow>
            <AnchorHeading
              id="trust-the-merge-not-the-speed"
              as="h1"
              className="mt-4 max-w-3xl text-5xl leading-[1.05] sm:text-6xl lg:text-7xl"
            >
              Trust the merge, not the speed.
            </AnchorHeading>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              Postil looks for the pull-request bugs reviewers usually have to reconstruct by hand:
              moved auth checks, unsafe deletes, race windows, bad migrations. Clean change? No
              filler comment.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <TrackedLink
                href="/install"
                cta="Install on GitHub"
                className={buttonVariants({ size: "lg" })}
              >
                Install on GitHub
              </TrackedLink>
              <TrackedLink
                href="/cli"
                cta="Try CLI"
                className={buttonVariants({ variant: "outline", size: "lg" })}
              >
                Try the CLI <ArrowRight className="ml-2 h-4 w-4" />
              </TrackedLink>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.75fr_1.25fr]">
          <div>
            <Eyebrow>What changes</Eyebrow>
            <AnchorHeading
              id="fewer-comments-better-reasons"
              as="h2"
              className="mt-4 text-4xl leading-tight"
            >
              Fewer comments. Better reasons.
            </AnchorHeading>
          </div>
          <div className="divide-y border-y">
            {proofPoints.map(([title, body]) => (
              <article key={title} className="grid gap-3 py-5 sm:grid-cols-[13rem_1fr]">
                <AnchorHeading
                  id={title.toLowerCase().replace(/\s+/g, "-")}
                  label={title}
                  as="h3"
                  className="flex items-center gap-3 text-xl"
                >
                  <CheckCircle2 className="h-5 w-5 text-accent" />
                  {title}
                </AnchorHeading>
                <p className="text-sm leading-6 text-muted-foreground">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Eyebrow>Status line</Eyebrow>
              <AnchorHeading
                id="compact-signal-no-counters"
                as="h2"
                className="mt-4 text-3xl leading-tight sm:text-4xl"
              >
                Compact signal, no counters.
              </AnchorHeading>
            </div>
            <Link href="/how-it-works" className="font-mono text-sm text-primary hover:underline">
              How reviews run
            </Link>
          </div>
          <div className="grid divide-y border-y sm:divide-y-0 md:grid-cols-4 md:gap-3 md:border-y-0">
            {statusExamples.map((item) => {
              const Icon = item.icon;
              return (
                <article
                  key={item.label}
                  className="flex items-center gap-4 py-4 sm:border sm:bg-card sm:p-5 md:block"
                >
                  <Icon className="h-5 w-5 shrink-0 text-accent" />
                  <div className="min-w-24 font-mono text-xs uppercase text-muted-foreground sm:mt-5">
                    {item.label}
                  </div>
                  <StatusLine
                    label="status:"
                    marks={item.status}
                    className="ml-auto text-base sm:ml-0 sm:mt-2 sm:text-lg"
                  />
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mb-8">
            <Eyebrow>Examples</Eyebrow>
            <AnchorHeading
              id="different-risks-same-restraint"
              as="h2"
              className="mt-4 text-4xl leading-tight"
            >
              Different risks, same restraint.
            </AnchorHeading>
          </div>
          <ReviewExamples />
        </div>
      </section>

      <section className="border-t py-16">
        <div className="mx-auto grid max-w-7xl gap-px border-y bg-border sm:grid-cols-[1.08fr_0.92fr]">
          <article className="bg-card p-6 sm:p-8">
            <Server className="h-6 w-6 text-accent" />
            <Eyebrow>Hosted</Eyebrow>
            <AnchorHeading
              id="managed-beta-stays-free-while-installs-open"
              as="h2"
              className="mt-4 max-w-lg text-4xl leading-tight"
            >
              Managed beta stays free while installs open.
            </AnchorHeading>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              The public app link lands on a wait page until review is done. No surprise billing
              while that door is closed.
            </p>
            <TrackedLink
              href="/install"
              cta="Join hosted beta"
              className={`${buttonVariants()} mt-7`}
            >
              Join beta
            </TrackedLink>
          </article>
          <div className="grid gap-px bg-border">
            <article className="grid gap-4 bg-background p-6 sm:grid-cols-[2rem_1fr] sm:p-8">
              <GitBranch className="h-6 w-6 text-accent" />
              <div>
                <Eyebrow>CI</Eyebrow>
                <AnchorHeading id="run-it-from-your-workflow" as="h2" className="mt-3 text-2xl">
                  Run it from your workflow.
                </AnchorHeading>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Add the CLI to GitHub Actions and keep model choice in repo config.
                </p>
              </div>
            </article>
            <article className="grid gap-4 bg-background p-6 sm:grid-cols-[2rem_1fr] sm:p-8">
              <TestTubeDiagonal className="h-6 w-6 text-accent" />
              <div>
                <Eyebrow>Benchmarks</Eyebrow>
                <AnchorHeading id="numbers-after-the-harness" as="h2" className="mt-3 text-2xl">
                  Numbers after the harness.
                </AnchorHeading>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Isolated PR fixtures first: real bugs, no upstream answers, human review before
                  claims.
                </p>
                <Link
                  href="/benchmarks"
                  className="mt-4 inline-flex text-sm text-primary hover:underline"
                >
                  Read the benchmark status
                </Link>
              </div>
            </article>
          </div>
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}

function ReviewExamples() {
  const [active, setActive] = useState(0);
  const [isAutoPlaying, setIsAutoPlaying] = useState(true);
  const rotationTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isAutoPlaying) return;
    if (rotationTimerRef.current !== null) {
      window.clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    rotationTimerRef.current = window.setTimeout(() => {
      rotationTimerRef.current = null;
      setActive((current) => (current + 1) % examples.length);
      setIsAutoPlaying(false);
    }, AUTO_ADVANCE_MS);
    return () => {
      if (rotationTimerRef.current !== null) {
        window.clearTimeout(rotationTimerRef.current);
        rotationTimerRef.current = null;
      }
    };
  }, [isAutoPlaying]);

  function pauseAndSelect(index: number) {
    if (rotationTimerRef.current !== null) {
      window.clearTimeout(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    setActive(index);
    setIsAutoPlaying(false);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      pauseAndSelect((index + 1) % examples.length);
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      pauseAndSelect((index - 1 + examples.length) % examples.length);
    }
    if (event.key === "Home") {
      event.preventDefault();
      pauseAndSelect(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      pauseAndSelect(examples.length - 1);
    }
  }

  const example = examples[active] ?? examples[0];

  return (
    <div className="min-w-0 border bg-card">
      <div className="border-b p-2">
        <div
          className="code-scrollbar flex gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Example categories"
        >
          {examples.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls={`example-panel-${item.id}`}
              id={`example-tab-${item.id}`}
              tabIndex={index === active ? 0 : -1}
              onClick={() => pauseAndSelect(index)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={[
                "relative shrink-0 border px-3 py-2 text-sm transition after:absolute after:inset-x-2 after:bottom-1 after:h-px after:origin-left after:bg-accent after:content-['']",
                index === active
                  ? "border-accent bg-highlight text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                index === active && isAutoPlaying
                  ? "after:animate-[review-example-progress_1000ms_linear_forwards]"
                  : "",
                index === active && !isAutoPlaying ? "after:scale-x-100" : "",
                index !== active ? "after:scale-x-0" : "",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <article
        className="grid min-h-[760px] min-w-0 grid-rows-[320px_1fr] gap-px overflow-hidden bg-border sm:min-h-[700px] sm:grid-rows-[300px_1fr] lg:min-h-[540px] lg:grid-cols-[0.9fr_1.1fr] lg:grid-rows-none"
        role="tabpanel"
        aria-labelledby={`example-tab-${example.id}`}
        id={`example-panel-${example.id}`}
      >
        <div className="flex min-h-0 min-w-0 flex-col bg-card p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="font-mono text-xs text-muted-foreground">{example.file}</div>
            <StatusMark kind={example.severity} />
          </div>
          <AnchorHeading
            id={`example-title-${example.id}`}
            as="h3"
            className="mt-4 text-3xl leading-tight"
          >
            {example.title}
          </AnchorHeading>
          <p className="mt-3 max-h-40 overflow-auto text-sm leading-6 text-muted-foreground sm:max-h-36">
            {example.body}
          </p>
          <div className="mt-auto pt-5">
            <StatusLine
              label="status:"
              marks={example.status}
              className="text-sm text-muted-foreground"
            />
          </div>
        </div>
        <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#1b2329] p-5 font-mono text-xs leading-6 text-[#f7f5f1]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-6 right-6 h-28 w-24 bg-contain bg-center bg-no-repeat opacity-[0.06] sm:h-36 sm:w-32"
            style={{ backgroundImage: "url('/brand/postil-mark.svg')" }}
          />
          <div className="mb-3 text-[#c8cdd2]">Patch shape</div>
          <DiffPreview removed={example.before} added={example.after} className="min-h-0 flex-1" />
        </div>
      </article>
      <style>{`
        @keyframes review-example-progress {
          from {
            transform: scaleX(0);
          }
          to {
            transform: scaleX(1);
          }
        }
      `}</style>
    </div>
  );
}
