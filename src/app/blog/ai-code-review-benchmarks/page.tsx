import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { BenchmarkCorpusChart } from "@/components/blog-figures";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("ai-code-review-benchmarks");
export const metadata = blogPostMetadata(post);

export default function BenchmarksArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          A benchmark score answers a question about a particular dataset, configuration,
          and scoring rule. Before comparing AI reviewers, check whether the tests ask the
          same question. Finding a seeded bug, avoiding an unsupported comment, and making
          the right merge decision require different measurements.
        </p>
        <h2>Check what counts as success</h2>
        <p>
          <a href="https://www.greptile.com/benchmarks">Greptile&apos;s published benchmark</a>{" "}
          tests detection of known bugs in 50 pull requests. Its catch rate excludes false
          positives and unrelated comments. That score measures detection, not the amount
          of review noise a team should expect.
        </p>
        <p>
          <a href="https://arxiv.org/abs/2509.01494">SWR-Bench</a> uses 1,000 manually
          verified pull requests with project context and evaluates generated reviews
          against structured ground truth. Differences in context, case selection, and
          scoring prevent a direct ranking from percentages reported by separate studies.
        </p>
        <h2>Include changes that deserve no finding</h2>
        <BenchmarkCorpusChart />
        <p>
          Postil&apos;s screening corpus combines seeded defects with clean changes. Clean
          cases reveal unsupported findings that a defect-only detection score can omit.
          They are a small, curated sample, so silence on these cases does not establish
          a real-world false-positive rate.
        </p>
        <dl>
          <dt><strong>Detection</strong></dt>
          <dd>The share of defect fixtures with a finding that overlaps the seeded path and line range. This score does not check whether the diagnosis is correct.</dd>
          <dt><strong>Clean-case silence</strong></dt>
          <dd>The share of clean fixtures without a reported finding. Read output failures separately.</dd>
          <dt><strong>Gate correctness</strong></dt>
          <dd>The share of scored cases whose pass or fail result matches the expected verdict.</dd>
        </dl>
        <p>
          Finding-level precision asks how many reported findings are valid; recall asks
          how many known issues are found. Their counting unit is the finding, which can
          differ from a fixture-level score. Always read the denominator and matching
          rules, including how the evaluator treats partial or failed output.
        </p>
        <h2>Run the suite and inspect the failures</h2>
        <p>
          The public <a href="https://github.com/postil-dev/postil-cli/tree/main/bench#readme">benchmark suite</a>{" "}
          contains the fixtures, evaluator, and setup instructions. The offline mock run
          checks the harness without calling a model. Live runs call a configured provider
          and incur usage charges. The <Link href="/bench#run-the-suite">benchmark page</Link>{" "}
          links the run instructions and downloadable results.
        </p>
        <p>
          Keep unscored cases visible alongside quality scores. Record total cost, latency,
          provider settings, and repeated runs on the same corpus. For a deployment with
          a pinned provider or retention requirement, test those constraints explicitly.
          Postil&apos;s screening results compare models inside its review harness; they
          are not a head-to-head test of competing hosted products.
        </p>
      </div>
    </div>
  );
}
