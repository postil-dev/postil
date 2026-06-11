import Link from "next/link";
import { AnchorHeading, CtaStrip, PageFrame, SectionIntro } from "../site";

export const metadata = {
  title: "Why Postil",
};

const reasons = [
  {
    title: "Low-noise behavior",
    body: "Clean PRs should stay quiet. Postil is built to return nothing when nothing risky is present, not a filler recap that only proves the bot ran.",
  },
  {
    title: "Hosted, CI, and CLI modes",
    body: "The same review model can run in the hosted beta, in GitHub Actions, or in the Rust CLI so teams do not have to choose between convenience and control.",
  },
  {
    title: "Evidence-grounded findings",
    body: "Findings should explain the changed line, the risky behavior, and the reason the merge path changes. If a claim cannot point at evidence, it should not ship.",
  },
  {
    title: "Security and privacy posture",
    body: "Public copy should state what is collected, where security issues go, and what the product does not do with diff data. That keeps trust claims concrete.",
  },
];

const fitPoints = [
  "Teams that already have formatters, tests, and branch protection but still miss behavior bugs in review.",
  "PRs where an inline finding is more useful than a longer summary paragraph.",
  "Review workflows that need a hosted path, a CI path, or a local CLI without changing the decision model.",
];

const caveats = [
  "Benchmark superiority claims are unavailable until reviewed eval data is public.",
  "Competitor comparisons are intentionally withheld until the research owner signs off.",
  "Product copy should distinguish shipped behavior from planned behavior.",
];

export default function WhyPostilPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Why Postil"
            title="The risky part is rarely the typo."
            body="Most teams already have formatters, tests, and CI. Postil exists for the cases those tools miss: auth checks that move, deletes that lose a tenant filter, and migrations that only work on empty data."
            id="top"
          />
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.78fr_1.22fr]">
          <div>
            <AnchorHeading id="who-this-is-for" as="h2" className="text-4xl leading-tight">
              Who this is for
            </AnchorHeading>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              Postil is a fit when the merge risk is in behavior, not formatting. The public site
              is careful about that boundary because the product should be legible to engineers
              before it is persuasive to everyone else.
            </p>
            <Link href="/how-it-works" className="mt-6 inline-flex text-sm text-primary hover:underline">
              See how the review flow works
            </Link>
          </div>
          <div className="border bg-card p-6">
            <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
              Typical fit
            </div>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              {fitPoints.map((item) => (
                <li key={item} className="flex gap-3">
                  <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:px-6 md:grid-cols-2">
          {reasons.map((reason) => (
            <article key={reason.title} className="border bg-card p-6">
              <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
                {reason.title}
              </div>
              <AnchorHeading
                id={reason.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
                label={reason.title}
                as="h2"
                className="mt-4 text-3xl"
              >
                {reason.title}
              </AnchorHeading>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{reason.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[1.05fr_0.95fr]">
          <article className="border bg-card p-6">
            <AnchorHeading id="what-stays-quiet" as="h2" className="text-3xl">
              What stays quiet
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              Quiet is part of the product promise. If Postil does not have a line-backed reason to
              call out a change, the right answer is silence, not a performative summary.
            </p>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              That keeps the review surface usable for serious teams. Developers can scan for the
              finding that matters without reading through output that only repeats the diff.
            </p>
          </article>
          <article className="border bg-card p-6">
            <AnchorHeading id="what-the-page-will-not-claim" as="h2" className="text-3xl">
              What this page will not claim
            </AnchorHeading>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              {caveats.map((item) => (
                <li key={item} className="flex gap-3">
                  <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.82fr_1.18fr]">
          <div>
            <AnchorHeading id="benchmarks" as="h2" className="text-4xl leading-tight">
              Benchmarks and status
            </AnchorHeading>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              Public benchmark numbers are not published until the data is reviewed. The public
              benchmark page explains the harness, what it measures, and why claim wording stays
              gated.
            </p>
            <Link
              href="/benchmarks"
              className="mt-6 inline-flex text-sm text-primary hover:underline"
            >
              Open the benchmark page
            </Link>
          </div>
          <div className="grid gap-4">
            <article className="border bg-card p-6">
              <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
                Method
              </div>
              <AnchorHeading id="benchmark-method" as="h3" className="mt-4 text-2xl leading-tight">
                Method
              </AnchorHeading>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                The benchmark harness uses isolated PR fixtures, real bugs, and separate scores for
                hits, misses, noise, and silence.
              </p>
            </article>
            <article className="border bg-card p-6">
              <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
                Boundary
              </div>
              <AnchorHeading
                id="benchmark-boundary"
                as="h3"
                className="mt-4 text-2xl leading-tight"
              >
                Boundary
              </AnchorHeading>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Until reviewed data lands, this page should describe the product honestly instead of
                promising ranking language the evidence does not yet support.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.82fr_1.18fr]">
          <div>
            <AnchorHeading id="what-trust-means-here" as="h2" className="text-4xl leading-tight">
              What trust means here
            </AnchorHeading>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              Postil should make the merge decision easier to audit, not louder. That means clear
              risk statements, explicit limits, and a quiet path for clean changes.
            </p>
          </div>
          <div className="border bg-card p-6">
            <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
              Trust signals
            </div>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              <li className="flex gap-3">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span>Findings should be tied to changed lines and concrete risk.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span>Clean reviews should remain quiet instead of adding noise.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span>Public claims should stay inside the evidence that has been reviewed.</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <CtaStrip />
    </PageFrame>
  );
}
