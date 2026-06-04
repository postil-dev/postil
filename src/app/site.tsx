import { ArrowRight, CheckCircle2, GitPullRequest, Info, ShieldCheck, TriangleAlert } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { DiffPreview } from "@/components/diff-preview";
import { StatusMark, type StatusKind } from "@/components/status-mark";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";

export const navItems = [
  { href: "/why-postil", label: "Why Postil" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
];

export const proofPoints = [
  ["Skips clean PRs", "No summary paragraph just to prove the bot ran."],
  ["Reads the thread", "Existing review comments and change requests stay in view."],
  ["Names the risk", "A finding should point at the changed line and the thing that can break."],
  ["Runs in CI", "Use the hosted app when it opens, or run the reviewer from your workflow today."],
];

export const statusExamples = [
  { label: "Pass", status: ["pass"] satisfies StatusKind[], icon: CheckCircle2 },
  { label: "Warning", status: ["warn", "warn", "info"] satisfies StatusKind[], icon: TriangleAlert },
  { label: "Blocking", status: ["error", "warn"] satisfies StatusKind[], icon: ShieldCheck },
  { label: "Context", status: ["info"] satisfies StatusKind[], icon: Info },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/92 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="Postil home">
          <BrandLockup />
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="px-3 py-2 text-muted-foreground transition hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <TrackedLink href="/install" cta="Install on GitHub" className={buttonVariants({ size: "sm" })}>
          Install
        </TrackedLink>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t py-10 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 sm:px-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-sm">
          <BrandLockup />
          <p className="mt-4 text-xs leading-6">
            Postil reviews pull requests for bugs that need code context. Hosted beta at postil.dev, CLI under Apache-2.0.
          </p>
        </div>
        <nav className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-4">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-foreground">
              {item.label}
            </Link>
          ))}
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <Link href="https://github.com/postil-dev/postil" className="hover:text-foreground">
            Source
          </Link>
          <Link href="/.well-known/security.txt" className="hover:text-foreground">
            Security
          </Link>
          <span>© {new Date().getFullYear()} Postil</span>
        </nav>
      </div>
    </footer>
  );
}

function BrandLockup() {
  return (
    <span className="flex items-center gap-3">
      <Image src="/brand/postil-mark.svg" alt="" width={36} height={36} priority />
      <span className="font-display text-2xl font-semibold leading-none text-foreground">Postil</span>
    </span>
  );
}

export function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-xs font-medium uppercase tracking-[0.16em] text-primary">{children}</div>;
}

export function SectionIntro({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="min-w-0 max-w-3xl">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="mt-4 text-4xl leading-tight sm:text-5xl">{title}</h1>
      {body ? <p className="mt-4 text-base leading-7 text-muted-foreground sm:text-lg">{body}</p> : null}
    </div>
  );
}

export function ReviewCard() {
  return (
    <div className="min-w-0 border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
      <div className="flex items-center justify-between border-b px-4 py-3 font-mono text-xs">
        <span className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-accent" />
          postil/review
        </span>
        <span className="rounded-sm border border-destructive/40 bg-diff-del px-2 py-1 text-[10px] uppercase text-destructive">
          Blocking
        </span>
      </div>
      <div className="p-5">
        <div className="font-mono text-xs text-muted-foreground">src/billing/plan.ts:84</div>
        <h2 className="mt-3 text-2xl leading-snug">Billing update now runs before authorization.</h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          The write moved ahead of `canManageBilling`, so a caller can change a plan before the permission failure is raised. Move the authorization check before the billing mutation.
        </p>
        <div className="mt-5">
          <DiffPreview
            removed="await billing.updatePlan(org.id, plan)"
            added={'if (!canManageBilling(actor, org)) throw new Error("authorization failed")\nawait billing.updatePlan(org.id, plan)'}
          />
        </div>
        <div className="mt-5 flex items-center gap-1 font-mono text-sm text-primary">
          <span className="mr-1">status:</span>
          <StatusMark kind="error" />
        </div>
      </div>
    </div>
  );
}

export function CtaStrip() {
  return (
    <section className="border-t bg-card py-14">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-3xl leading-tight">Trust the merge, not the speed.</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Join the hosted beta queue, or run the reviewer CLI in your own CI.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <TrackedLink href="/install" cta="Install on GitHub" className={buttonVariants()}>
            Install on GitHub
          </TrackedLink>
          <TrackedLink href="https://github.com/postil-dev/postil-reviewer" cta="Try CLI" className={buttonVariants({ variant: "outline" })}>
            Try the CLI <ArrowRight className="ml-2 h-4 w-4" />
          </TrackedLink>
        </div>
      </div>
    </section>
  );
}
