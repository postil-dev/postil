import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { BENCH } from "@/components/bench-table";
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
          Benchmark percentages describe a dataset, configuration, and scoring rule. Postil&apos;s
          screening corpus contains {BENCH.defectCases} seeded defect fixtures and
          {" "}{BENCH.cleanCases} clean fixtures, {BENCH.defectCases + BENCH.cleanCases} cases in
          total. Detection, clean-case silence, and gate correctness use different denominators and
          answer different questions.
        </p>
        <h2>Published benchmark designs</h2>
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
        <h2>Postil screening corpus</h2>
        <BenchmarkCorpusChart />
        <p>
          The {BENCH.cleanCases} clean changes expose unsupported findings that a defect-only score
          omits. They are a small curated sample, so silence on them does not estimate a production
          false-positive rate.
        </p>
        <dl>
          <dt><strong>Detection</strong></dt>
          <dd>The share of {BENCH.defectCases} defect fixtures with a finding that overlaps the seeded path and line range. This score does not check whether the diagnosis is correct.</dd>
          <dt><strong>Clean-case silence</strong></dt>
          <dd>The share of {BENCH.cleanCases} clean fixtures without a reported finding. Output failures remain separate.</dd>
          <dt><strong>Gate correctness</strong></dt>
          <dd>The share of scored cases whose gate conclusion matches the expected verdict. An unscored case is excluded from this denominator.</dd>
        </dl>
        <p>
          Finding-level precision is the share of reported findings that are valid. Recall is the share
          of known issues detected. Those units differ from a fixture-level score. The evaluator reports
          partial and failed output separately from scored cases.
        </p>
        <p>
          The public <a href="https://github.com/postil-dev/postil-cli/tree/main/bench#readme">benchmark suite</a>
          {" "}contains the fixtures and evaluator. Its offline mock run tests the harness without a
          model call; live runs call a configured provider and incur usage charges. The
          {" "}<Link href="/bench">results table</Link> retains each row&apos;s cost, latency, provider
          settings, and unscored cases. These are screening results inside one review harness, not a
          production forecast or a ranking of hosted review products.
        </p>
      </div>
    </div>
  );
}
