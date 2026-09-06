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
          GPT-5.6 Luna flags {count(luna.detectionRate, BENCH.defectCases)} of the
          {" "}{BENCH.defectCases} planted bug locations in the <Link href="/bench">Postil benchmark</Link>.
          GLM-5.2 flags {count(glm.detectionRate, BENCH.defectCases)}. That looks like a close result
          until you compare the bills: ${luna.totalCostUsd!.toFixed(4)} for Luna&apos;s run and
          {" "}${glm.totalCostUsd!.toFixed(4)} for GLM&apos;s. On this test set, GLM costs about ten
          times as much without matching more bug locations.
        </p>
        <h2>What counts as finding a bug?</h2>
        <p>
          The detection score has a narrow definition. A finding counts when it points to the
          file and line range containing a planted bug. A comment on the right lines can still
          give the wrong explanation. The score does not check that, so it cannot tell you how
          many findings a developer can use to fix the code. You have to read the findings to judge that.
        </p>
        <p>
          A reviewer that blocks merges also needs to make the right pass or fail decision.
          Luna agrees with the expected decision in {count(luna.gateVerdictCorrectness, luna.casesRun)} of
          {" "}{luna.casesRun} cases; GLM agrees in
          {" "}{count(glm.gateVerdictCorrectness, glm.casesRun - glm.unscoredCases)} of
          {" "}{glm.casesRun - glm.unscoredCases} scored cases, with {glm.unscoredCases} unscored.
          The similar detection scores hide a larger difference in merge decisions.
        </p>
        <CostAgainstGateChart />
        <h2>How much work does the review create?</h2>
        <p>
          Both models leave all {BENCH.cleanCases} clean test cases alone. That is useful evidence
          if you want a reviewer that can approve a change without inventing something to say,
          though {BENCH.cleanCases} cases cover little of the code it can encounter in a real repository.
        </p>
        <CleanReviewChart />
        <p>
          GLM also reports {glm.falsePositives} findings outside the planted bug locations in the
          defective cases. These need inspection: they can be false alarms or other bugs the test
          does not label. Either way, someone has to check them. A detection percentage does not
          account for that work.
        </p>
        <h2>Check the wait, and run it again</h2>
        <p>
          Luna&apos;s p95 response time is {secondsLabel(luna.latencyMsP95)};
          GLM&apos;s is {secondsLabel(glm.latencyMsP95)}. At the 95th percentile, a developer waits
          nearly three times as long for GLM. This matters even when the model bill is small.
        </p>
        <p>
          Repeated runs show how much the results vary. The chart also includes a Luna run with
          widespread output failures. A review that produces no usable answer still delays a merge,
          even if the model scores well when it responds.
        </p>
        <DetectionSpreadChart />
        <p>
          Choose the provider along with the model. OpenRouter can send requests for the same
          model to different providers; the report includes separate results with a fixed provider.
          To evaluate the setup you intend to use, keep that choice fixed and
          {" "}<Link href="/bench#run-the-suite">run the public suite</Link>. Read the findings
          alongside the <a href="/bench/postil-model-bench.json">scores and request data</a>, then
          try it on changes from your own repository before letting it block merges.
        </p>
      </div>
    </div>
  );
}
