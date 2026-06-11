import Link from "next/link";
import { AnchorHeading, CtaStrip, PageFrame, SectionIntro } from "../site";

export const metadata = {
  title: "Benchmarks",
};

const harnessScript = "scripts/run-pr-review-benchmark.ts";
const harnessCore = "src/benchmarks/pr-review-harness.ts";

const methodology = [
  "Benchmarks run on isolated PR fixtures, not live repositories.",
  "Cases use real bugs and avoid upstream fixes in the prompt context.",
  "Scores separate hits, misses, noisy output, and clean silence.",
  "Public numbers stay unpublished until human review approves the claim language.",
];

const caveats = [
  "No superiority claim is published here.",
  "No competitor comparison is published here.",
  "No scorecard is treated as final until the reviewed data is ready.",
];

export default function BenchmarksPage() {
  return (
    <PageFrame>
      <section className="border-b py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionIntro
            eyebrow="Benchmarks"
            title="Methodology first. Claims later."
            body="The harness exists in the repo, but public numbers stay gated until the evals are reviewed. Until then, this page explains how the benchmark is set up and what it is not claiming."
            id="top"
          />
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-4 px-4 sm:px-6 lg:grid-cols-2">
          <article className="border bg-card p-6">
            <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">Status</div>
            <AnchorHeading
              id="public-results-are-coming-after-human-review"
              as="h2"
              className="mt-4 text-3xl"
            >
              Public results are coming after human review.
            </AnchorHeading>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              The public site does not publish benchmark superiority language before the numbers,
              fixtures, and claim wording are approved.
            </p>
          </article>
          <article className="border bg-card p-6">
            <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">
              Sources
            </div>
            <AnchorHeading id="the-code-path-already-exists" as="h2" className="mt-4 text-3xl">
              The code path already exists.
            </AnchorHeading>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              <li>
                Benchmark runner:{" "}
                <Link
                  href={`https://github.com/postil-dev/postil/blob/main/${harnessScript}`}
                  className="text-primary hover:underline"
                >
                  {harnessScript}
                </Link>
              </li>
              <li>
                Harness core:{" "}
                <Link
                  href={`https://github.com/postil-dev/postil/blob/main/${harnessCore}`}
                  className="text-primary hover:underline"
                >
                  {harnessCore}
                </Link>
              </li>
            </ul>
          </article>
        </div>
      </section>

      <section className="border-b py-16">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-2">
          <article className="border bg-card p-6">
            <AnchorHeading id="methodology" as="h2" className="text-3xl">
              Methodology
            </AnchorHeading>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
              {methodology.map((item) => (
                <li key={item} className="flex gap-3">
                  <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
          <article className="border bg-card p-6">
            <AnchorHeading id="caveats" as="h2" className="text-3xl">
              Claim boundaries
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

      <section className="py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.92fr_1.08fr]">
          <div>
            <AnchorHeading id="what-is-measured" as="h2" className="text-4xl leading-tight">
              What is measured
            </AnchorHeading>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              The current harness separates useful findings from noisy output so the public page can
              describe actual behavior instead of marketing-shaped certainty.
            </p>
          </div>
          <div className="border bg-card p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <Metric name="Hits" body="Real findings matched by the ground truth." />
              <Metric name="Misses" body="Relevant bugs the model failed to report." />
              <Metric name="Noise" body="Extra findings that do not change merge risk." />
              <Metric name="Silence" body="Clean cases that should stay quiet." />
            </div>
          </div>
        </div>
      </section>

      <CtaStrip />
    </PageFrame>
  );
}

function Metric({ name, body }: { name: string; body: string }) {
  return (
    <article className="border p-4">
      <div className="font-mono text-xs uppercase tracking-[0.16em] text-primary">{name}</div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{body}</p>
    </article>
  );
}
