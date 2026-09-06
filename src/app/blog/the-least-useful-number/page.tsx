import Link from "next/link";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { CostAgainstGateChart, DetectionSpreadChart } from "@/components/bench-charts";
import { CleanReviewChart } from "@/components/blog-figures";
import { BENCH, benchModel, secondsLabel } from "@/components/bench-table";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";

const post = getBlogPost("the-least-useful-number");
export const metadata = blogPostMetadata(post);
const luna = benchModel("openai/gpt-5.6-luna");
const glm = benchModel("z-ai/glm-5.2");
const lunaRepeatRuns = BENCH.repeatRuns?.models.find((model) => model.id === luna.id);

if (!lunaRepeatRuns) throw new Error(`repeat runs missing for ${luna.id}`);
const validLunaRepeatRates = lunaRepeatRuns.detectionRates.filter(
  (_, index) => !lunaRepeatRuns.degradedRunIndexes?.includes(index),
);

function count(rate: number | undefined, denominator: number): number {
  return Math.round((rate ?? 0) * denominator);
}

export default function LeastUsefulNumberArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          In the <Link href="/bench">model benchmark</Link>, GPT-5.6 Luna is cheaper and faster than
          {" "}GLM-5.2, with comparable seeded-location matches: {count(luna.detectionRate, BENCH.defectCases)} of
          {" "}{BENCH.defectCases} for Luna and {count(glm.detectionRate, BENCH.defectCases)} for GLM.
        </p>
        <p>
          Luna returns the expected gate verdict in {count(luna.gateVerdictCorrectness, luna.casesRun)}
          {" "}of {luna.casesRun} cases. GLM returns it in
          {" "}{count(glm.gateVerdictCorrectness, glm.casesRun - glm.unscoredCases)} of
          {" "}{glm.casesRun - glm.unscoredCases} scored cases, with {glm.unscoredCases} case
          unscored. Both are silent on {BENCH.cleanCases} clean fixtures. GLM also produces
          {" "}{glm.falsePositives} unmatched findings on defect fixtures. Gate correctness matters
          when a review can block a merge. Unmatched findings need human triage to distinguish other
          defects from false alarms.
        </p>
        <p>
          Luna&apos;s run costs ${luna.totalCostUsd!.toFixed(4)} and its p95 latency is
          {" "}{secondsLabel(luna.latencyMsP95)}. GLM&apos;s costs ${glm.totalCostUsd!.toFixed(4)} and
          its p95 latency is {secondsLabel(glm.latencyMsP95)}.
        </p>
        <p>
          Detection records whether a finding overlaps the seeded path and line range. Location overlap
          does not establish that the finding diagnoses the defect correctly.
        </p>
        <h2>Repeated runs and routing</h2>
        <p>
          Luna&apos;s valid repeated runs find
          {" "}{validLunaRepeatRates.map((rate) => count(rate, BENCH.defectCases)).join(", ")}
          {" "}of the {BENCH.defectCases} seeded locations. The same chart includes one run with
          widespread output failures.
        </p>
        <DetectionSpreadChart />
        <p>
          Luna&apos;s unconstrained row permits provider-route variation and has
          {" "}{count(luna.detectionRate, BENCH.defectCases)} seeded-location matches and
          {" "}{secondsLabel(luna.latencyMsP95)} p95 latency. Its pinned-provider summary fixes a
          route across {luna.pinnedProviderContract?.runs} runs and reports
          {" "}{(luna.pinnedProviderContract?.detectionRate! * 100).toFixed(1)}% detection and
          {" "}{secondsLabel(luna.pinnedProviderContract?.latencyMsP95)} p95 latency. For production,
          use the same provider route you evaluate; the model identifier alone does not specify it.
        </p>
        <CleanReviewChart />
        <p>
          Silence counts clean fixtures with no reported finding. Gate correctness counts scored cases
          whose pass or fail verdict matches the fixture expectation. Detection, silence, and gate
          correctness measure different review outcomes.
        </p>
        <CostAgainstGateChart />
        <p>
          The <a href="/bench/postil-model-bench.json">report data</a> and
          {" "}<Link href="/bench#run-the-suite">public suite</Link> retain the fixtures,
          evaluator, routes, costs, and output failures behind these rows.
        </p>
      </div>
    </div>
  );
}
