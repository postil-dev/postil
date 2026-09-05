import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { CostAgainstGateChart, DetectionSpreadChart } from "@/components/bench-charts";
import { CleanReviewChart } from "@/components/blog-figures";
import { BENCH, benchModel, secondsLabel } from "@/components/bench-table";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("the-least-useful-number");
export const metadata = blogPostMetadata(post);
const luna = benchModel("openai/gpt-5.6-luna");
const kimi = benchModel("moonshotai/kimi-k2.7-code");

export default function LeastUsefulNumberArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          A reviewer can flag most seeded regions and still interrupt clean pull requests.
          Choosing a model requires both measurements, along with the accuracy of its merge
          decisions and the cost of a complete review. Postil&apos;s <Link href="/bench">model benchmark</Link>{" "}
          reports them separately on {BENCH.defectCases} defect fixtures and {BENCH.cleanCases} clean fixtures.
          Its detection score counts findings that overlap a seeded location; it does not
          verify that the finding explains the defect correctly.
        </p>
        <h2>Read the variation before the ranking</h2>
        <p>
          Repeated runs of the same model produce different detection scores. The chart
          shows each run on the same corpus, including a run with substantial output failures.
          Overlapping results are a reason to gather more evidence before choosing between
          models with similar scores.
        </p>
        <DetectionSpreadChart />
        <p>
          These few repeats do not establish confidence intervals or prove that two models
          are equivalent. They show how much a single measurement can move under the
          screening conditions.
        </p>
        <h2>Check what happens on clean code</h2>
        <CleanReviewChart />
        <p>
          Silence counts clean fixtures with no reported finding. False findings count
          unmatched envelope findings across clean and defect fixtures, so a single review
          can contribute several. Read both
          alongside the unscored-case count: an output failure is not evidence that a model
          correctly recognized clean code.
        </p>
        <p>
          Gate correctness asks a different question: did the pass or fail decision match
          the fixture&apos;s expected verdict? The results table reports that percentage over
          scored cases and lists unscored cases separately. Detection alone does not tell
          you whether a review blocks the right changes.
        </p>
        <h2>Measure the complete bill</h2>
        <CostAgainstGateChart />
        <p>
          Token prices need token counts to become a review cost. Reasoning, output length,
          and retries affect the bill. In this screening sample, <code>{luna.id}</code> costs{" "}
          ${luna.totalCostUsd!.toFixed(4)} across {luna.casesRun} fixtures, with a p95 latency
          of {secondsLabel(luna.latencyMsP95)}. That is a measured test-run cost, not a quote
          for reviewing a production repository.
        </p>
        <h2>Use the provider settings you intend to deploy</h2>
        <p>
          The main table uses unconstrained provider routing. Separate provider-constrained
          results use a pinned endpoint with a zero-retention requirement and price limits.
          For <code>{kimi.id}</code>, p95 latency is {secondsLabel(kimi.latencyMsP95)} in the
          screening run and {secondsLabel(kimi.pinnedProviderContract?.latencyMsP95)} in the
          provider-constrained summary. Routing is part of the experiment.
        </p>
        <p>
          Start with the <Link href="/bench#run-the-suite">benchmark instructions</Link>, inspect
          the <a href="/bench/postil-model-bench.json">report data</a>, and test representative
          changes from your own codebase. Keep the corpus, model settings, provider policy,
          failures, and total cost with the results so the comparison remains inspectable.
        </p>
      </div>
    </div>
  );
}
