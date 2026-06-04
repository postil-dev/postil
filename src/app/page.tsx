import { ArrowRight, CheckCircle2, GitBranch, Server, TestTubeDiagonal } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { ReviewExamples } from "@/components/review-examples";
import { StatusLine } from "@/components/status-line";
import { TrackedLink } from "@/components/tracked-link";
import { buttonVariants } from "@/components/ui/button";
import { CtaStrip, Eyebrow, PageFrame, proofPoints, statusExamples } from "./site";

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
          className="absolute inset-x-0 top-0 h-[30vh] w-full object-contain object-right-top sm:inset-0 sm:h-full sm:object-cover sm:object-center"
        />
        <div className="absolute inset-x-0 top-0 h-[34vh] bg-gradient-to-b from-transparent via-background/12 to-background sm:inset-0 sm:h-auto sm:bg-[linear-gradient(90deg,#f7f5f1_0%,rgba(247,245,241,0.96)_22%,rgba(247,245,241,0.76)_46%,rgba(247,245,241,0.18)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 hidden h-40 bg-gradient-to-b from-transparent to-background sm:block" />
        <div className="relative z-10 mx-auto flex max-w-7xl items-start px-4 pb-14 pt-[28vh] sm:min-h-[calc(100vh-4rem)] sm:items-center sm:px-6 sm:py-14">
          <div className="max-w-3xl">
            <Eyebrow>Calm review gate</Eyebrow>
            <h1 className="mt-4 max-w-3xl text-5xl leading-[1.05] sm:text-6xl lg:text-7xl">
              Trust the merge, not the speed.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              Postil looks for the pull-request bugs reviewers usually have to reconstruct by hand: moved auth checks, unsafe deletes, race windows, bad migrations. Clean change? No filler comment.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <TrackedLink href="/install" cta="Install on GitHub" className={buttonVariants({ size: "lg" })}>
                Install on GitHub
              </TrackedLink>
              <TrackedLink href="https://github.com/postil-dev/postil-reviewer" cta="Try CLI" className={buttonVariants({ variant: "outline", size: "lg" })}>
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
            <h2 className="mt-4 text-4xl leading-tight">Fewer comments. Better reasons.</h2>
          </div>
          <div className="divide-y border-y">
            {proofPoints.map(([title, body]) => (
              <article key={title} className="grid gap-3 py-5 sm:grid-cols-[13rem_1fr]">
                <h3 className="flex items-center gap-3 text-xl">
                  <CheckCircle2 className="h-5 w-5 text-accent" />
                  {title}
                </h3>
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
              <h2 className="mt-4 text-3xl leading-tight sm:text-4xl">Compact signal, no counters.</h2>
            </div>
            <Link href="/how-it-works" className="font-mono text-sm text-primary hover:underline">
              How reviews run
            </Link>
          </div>
          <div className="grid divide-y border-y sm:divide-y-0 md:grid-cols-4 md:gap-3 md:border-y-0">
            {statusExamples.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.label} className="flex items-center gap-4 py-4 sm:border sm:bg-card sm:p-5 md:block">
                  <Icon className="h-5 w-5 shrink-0 text-accent" />
                  <div className="min-w-24 font-mono text-xs uppercase text-muted-foreground sm:mt-5">{item.label}</div>
                  <StatusLine label="status:" marks={item.status} className="ml-auto text-base sm:ml-0 sm:mt-2 sm:text-lg" />
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
            <h2 className="mt-4 text-4xl leading-tight">Different risks, same restraint.</h2>
          </div>
          <ReviewExamples />
        </div>
      </section>

      <section className="border-t py-16">
        <div className="mx-auto grid max-w-7xl gap-px border-y bg-border sm:grid-cols-[1.08fr_0.92fr]">
          <article className="bg-card p-6 sm:p-8">
            <Server className="h-6 w-6 text-accent" />
            <Eyebrow>Hosted</Eyebrow>
            <h2 className="mt-4 max-w-lg text-4xl leading-tight">Managed beta stays free while installs open.</h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              The public app link lands on a wait page until review is done. No surprise billing while that door is closed.
            </p>
            <TrackedLink href="/install" cta="Join hosted beta" className={`${buttonVariants()} mt-7`}>
              Join beta
            </TrackedLink>
          </article>
          <div className="grid gap-px bg-border">
            <article className="grid gap-4 bg-background p-6 sm:grid-cols-[2rem_1fr] sm:p-8">
              <GitBranch className="h-6 w-6 text-accent" />
              <div>
                <Eyebrow>CI</Eyebrow>
                <h2 className="mt-3 text-2xl">Run it from your workflow.</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Add the CLI to GitHub Actions and keep model choice in repo config.
                </p>
              </div>
            </article>
            <article className="grid gap-4 bg-background p-6 sm:grid-cols-[2rem_1fr] sm:p-8">
              <TestTubeDiagonal className="h-6 w-6 text-accent" />
              <div>
                <Eyebrow>Benchmarks</Eyebrow>
                <h2 className="mt-3 text-2xl">Numbers after the harness.</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Isolated PR fixtures first: real bugs, no upstream answers, human review before claims.
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}
