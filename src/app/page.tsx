import { ArrowRight, CheckCircle2 } from "lucide-react";
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

      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Eyebrow>Status line</Eyebrow>
              <h2 className="mt-4 text-4xl leading-tight">Compact signal, no counters.</h2>
            </div>
            <Link href="/how-it-works" className="font-mono text-sm text-primary hover:underline">
              How reviews run
            </Link>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            {statusExamples.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.label} className="border bg-card p-5">
                  <Icon className="h-5 w-5 text-accent" />
                  <div className="mt-5 font-mono text-xs uppercase text-muted-foreground">{item.label}</div>
                  <StatusLine label="status:" marks={item.status} className="mt-2 text-lg" />
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
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-3">
          <article className="border bg-card p-6">
            <Eyebrow>Hosted</Eyebrow>
            <h2 className="mt-4 text-3xl">Managed beta is free.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Hosted reviews are free while public access opens and billing stays off.
            </p>
          </article>
          <article className="border bg-card p-6">
            <Eyebrow>CI</Eyebrow>
            <h2 className="mt-4 text-3xl">Runs where teams already work.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Add the reviewer CLI to GitHub Actions and keep the model/provider choice in your repo.
            </p>
          </article>
          <article className="border bg-card p-6">
            <Eyebrow>Benchmarks</Eyebrow>
            <h2 className="mt-4 text-3xl">Independent evals are coming.</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              We are preparing isolated PR fixtures with real bugs and no upstream answers before publishing numbers.
            </p>
          </article>
        </div>
      </section>
      <CtaStrip />
    </PageFrame>
  );
}
