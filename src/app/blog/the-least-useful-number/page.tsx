import Link from "next/link";
import { CleanReviewChart } from "@/components/blog-figures";
import { BlogArticleHeader } from "@/app/blog/blog-article-header";
import { BENCH, benchModel, secondsLabel } from "@/components/bench-table";
import { blogPostJsonLd, blogPostMetadata, getBlogPost } from "@/lib/blog-posts";
import caseEvidence from "../../../../public/bench/screening-0.8.26-case-evidence.json";
import cleanBank from "../../../../public/bench/screening-0.9.7-clean-bank-v2.json";

const post = getBlogPost("the-least-useful-number");
export const metadata = blogPostMetadata(post);
const luna = benchModel("openai/gpt-5.6-luna");
const glm = benchModel("z-ai/glm-5.2");
const comparedModels = [luna, glm];
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
          GPT-5.6 Luna receives detection credit on {count(luna.detectionRate, BENCH.defectCases)} of
          {" "}{BENCH.defectCases} defect cases in the <Link href="/bench">Postil screening benchmark</Link>;
          GLM-5.2 receives credit on {count(glm.detectionRate, BENCH.defectCases)}.
          That one-case difference says little about the explanation a developer receives or the
          decision a merge gate makes. The same runs differ in gate results, output failures,
          recorded cost and response time.
        </p>
        <h2>A location match is not a verified diagnosis</h2>
        <p>
          Each defect case is a prepared change with a known faulty file and line range.
          Detection credit requires a finding that overlaps that location. A comment on the right
          lines can receive credit while explaining the wrong problem: the detection score does not
          judge its reasoning. These figures measure location matches, not the number of correct,
          actionable diagnoses.
        </p>
        <div className="overflow-x-auto">
          <table>
            <caption>One screening run per model, using {BENCH.defectCases + BENCH.cleanCases} cases and unconstrained provider routing</caption>
            <thead><tr><th scope="col">Measurement</th><th scope="col">GPT-5.6 Luna</th><th scope="col">GLM-5.2</th></tr></thead>
            <tbody>
              <tr><th scope="row">Defect cases with a location match</th>{comparedModels.map(model => <td key={model.id}>{count(model.detectionRate, BENCH.defectCases)} / {BENCH.defectCases}</td>)}</tr>
              <tr><th scope="row">Correct gate verdicts / scored cases</th>{comparedModels.map(model => <td key={model.id}>{count(model.gateVerdictCorrectness, model.casesRun - model.unscoredCases)} / {model.casesRun - model.unscoredCases}</td>)}</tr>
              <tr><th scope="row">Cases without a scored result</th>{comparedModels.map(model => <td key={model.id}>{model.unscoredCases} / {model.casesRun}</td>)}</tr>
              <tr><th scope="row">Recorded run cost</th>{comparedModels.map(model => <td key={model.id}>${model.totalCostUsd!.toFixed(4)}</td>)}</tr>
              <tr><th scope="row">95th-percentile case latency</th>{comparedModels.map(model => <td key={model.id}>{secondsLabel(model.latencyMsP95)}</td>)}</tr>
            </tbody>
          </table>
        </div>
        <p>
          Gate correctness asks whether the result agrees with the fixture&apos;s expected pass or fail
          decision. Some defects should block; advisory defects should remain visible without failing
          the gate. Finding a defect&apos;s location does not guarantee the model assigns a severity
          or finding kind that produces the expected decision.
        </p>
        <div className="overflow-x-auto">
          <table>
            <caption>Gate outcomes across all 70 attempted cases, relative to the authored verdicts</caption>
            <thead><tr><th scope="col">Outcome</th><th scope="col">GPT-5.6 Luna</th><th scope="col">GLM-5.2</th></tr></thead>
            <tbody>
              {([
                ["correctPass", "Correct pass"], ["correctBlock", "Correct block"],
                ["falsePass", "Pass when the fixture requires a block"],
                ["falseBlock", "Block when the fixture expects a pass"],
                ["unavailable", "Unavailable review result"],
              ] as const).map(([key, label]) => <tr key={key}><th scope="row">{label}</th>{caseEvidence.runs.map(run => <td key={run.model}>{run.counts[key]} / {run.results.length}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
        <p>
          The largest difference is in cases that should block under the benchmark&apos;s policy:
          Luna passes two and GLM passes twelve. In the archive-deletion case, for example, both
          models find the replacement of <code>archiveFile</code> with <code>storage.delete</code>
          but label it a warning. The fixture requires preserving the recovery copy and assigns
          error severity, so both gates pass a change the fixture expects them to block.
        </p>
        <p>
          Disagreement also runs the other way. The disabled-timeout fixture is authored as a warning,
          which should pass the error-only gate. Both models label it an error and block it.
          These counts measure agreement with the benchmark&apos;s severity policy, not a universal
          verdict about which risks every repository must accept. The
          {" "}<a href="/bench/screening-0.8.26-case-evidence.json">case evidence</a> includes the
          authored targets, source excerpts, model findings and individual gate outcomes.
        </p>
        <p>
          GLM has {glm.unscoredCases} unscored case: a cache-expiry change that returns milliseconds
          where seconds are required. Its result is an operational error labeled
          {" "}<code>review/invalidOutput</code>, so there is no usable review to score. This case is
          excluded from gate correctness, leaving {glm.casesRun - glm.unscoredCases} scored decisions.
          It remains in the attempted-case count and earns no detection credit. The error label does
          not identify the cause of the invalid output.
        </p>
        <h2>What the clean cases establish</h2>
        <p>
          A clean case is a prepared change that needs no finding under its supplied code and
          contracts. The
          {" "}{BENCH.cleanCases} clean fixtures include comment and documentation edits, variable and
          type renames, test maintenance, formatting changes and safe changes to authorization, cache
          expiry and concurrent fetching. The
          {" "}<a href="https://github.com/postil-dev/postil-cli/tree/main/bench#readme">fixture suite</a>
          {" "}contains the changes and expected results. A variable rename that preserves the return
          value, for example, tests whether harmless editing attracts an invented defect report.
        </p>
        <CleanReviewChart />
        <p>
          The final Postil reviews contain no findings on every clean case in these historical runs. This small,
          curated sample does not distinguish them.
        </p>
        <h2>A separate 25-case clean comparison</h2>
        <p>
          The <a href="/bench/screening-0.9.7-clean-bank-v2.json">expanded clean bank</a> combines the same 13 clean
          cases with 12 executable examples of safe application changes. These include extracting
          a tenant check without changing who can read a project, preserving cache expiry at the
          exact boundary and keeping a zero-valued retry setting distinct from an absent setting.
          Each supplemental source diff states the contract that makes its change safe.
        </p>
        <p>
          For example, replacing an explicit null-or-undefined check with <code>config.retries ?? 3</code>
          preserves zero as a request for no retries. Replacing that expression with a truthiness
          check would instead turn zero into three. This case tests a reviewer&apos;s ability to accept
          the safe simplification under a stated configuration contract.
        </p>
        <CleanReviewChart experiment="expanded" />
        <p>
          In one matched run per model, all 25 final Postil reviews are valid and contain no findings.
          Luna uses Azure EU; GLM uses the Z.AI route. Both use the same fixture, evaluator and binary
          hashes, three concurrent cases, no outer case retries and provider fallbacks disabled.
          The recorded charges are ${cleanBank.models.find(model => model.model === luna.id)!.observedProviderCostUsdDecimal} for Luna
          and ${cleanBank.models.find(model => model.model === glm.id)!.observedProviderCostUsdDecimal} for GLM. These are costs for
          this clean-only experiment, not replacements for the 70-case run costs above.
        </p>
        <p>
          This result extends the kinds of safe changes tested but does not separate the final reviews on
          silence. It measures the complete Postil review pipeline, including finding suppression,
          rather than whether the models generate any candidate concerns. One observation per case
          and model cannot establish a stable false-positive rate.
          The 25-case experiment uses a different binary and corpus from the historical report;
          its results do not change the 57-defect and 13-clean denominators in that report.
        </p>
        <p>
          The runtime contract matters too. A version of the optional-field example without an
          explicit runtime guarantee retains a Luna compatibility warning about <code>Object.hasOwn</code>
          in the final review.
          That warning is not an established false alarm when support for the method is unspecified.
          The 25-case comparison supplies the runtime guarantee in the diff. The evidence file retains
          the separate variant&apos;s result so the two inputs are not mistaken for repeated runs of
          an unchanged case.
        </p>
        <h2>What the three extra findings say</h2>
        <p>
          The report records <code>falsePositives: {glm.falsePositives}</code> for GLM. The evaluator
          credits at most one finding per defect case. The counter includes every additional
          finding, whether it duplicates that match or raises a different concern. The recorded three comprise
          one duplicate diagnosis and two compatibility concerns that the supplied contracts do not
          establish as defects. Their code excerpts and complete finding text are in the
          {" "}<a href="/bench/screening-0.8.26-case-evidence.json">versioned case evidence</a>.
        </p>
        <p>
          In the configuration-loader case, <code>return defaultConfig</code> becomes
          {" "}<code>throw err</code>, beside a comment that still promises fallback to defaults.
          GLM reports the misleading comment and the lost fallback behavior at the same line,
          {" "}<code>src/config/load.ts:26</code>. Both describe the seeded fallback-contract defect.
          The second report is a duplicate, not another bug or a finding outside the target location.
        </p>
        <p>
          In the provider-client case, the seeded defect disables a request timeout. GLM also flags
          a metric rename from <code>provider.request</code> to <code>provider.requests</code> and an
          {" "}<code>Accept</code> header change from <code>application/json</code> to
          {" "}<code>application/vnd.api+json</code>. Its metric warning asserts that existing consumers
          lose data, but the supplied context identifies neither such consumers nor a stable-name
          contract. Its header warning is conditional on endpoints rejecting the requested type;
          the supplied endpoint contract does not establish that rejection. These are compatibility
          questions, not demonstrated failures in the supplied code.
        </p>
        <p>
          The counter therefore measures findings beyond the first location match, rather than
          unique false alarms. Counting the duplicate as an extra bug would inflate detection;
          accepting the compatibility warnings as proven would add facts absent from the fixture.
        </p>
        <h2>Recorded cost and repeated runs</h2>
        <p>
          Luna&apos;s run records ${luna.totalCostUsd!.toFixed(4)} in provider charges;
          GLM&apos;s records ${glm.totalCostUsd!.toFixed(4)}. These totals cover a benchmark run,
          not a hosted subscription or a typical pull request. The recorded p95 case latency is
          {" "}{secondsLabel(luna.latencyMsP95)} for Luna and {secondsLabel(glm.latencyMsP95)} for GLM.
          The percentile uses the CLI&apos;s review timer for each scored case&apos;s final invocation,
          from diff preparation to construction of the result. It includes model calls and internal
          repairs within that invocation. It excludes unavailable cases, earlier outer attempts,
          retry backoff, process startup and the surrounding CI or developer workflow.
        </p>
        <figure className="my-8">
          <div className="overflow-x-auto">
            <table>
              <caption>Location-detection rates across repeated runs on the same corpus</caption>
              <thead><tr><th scope="col">Model</th><th scope="col">Run 1</th><th scope="col">Run 2</th><th scope="col">Run 3</th><th scope="col">Run 4</th></tr></thead>
              <tbody>
                {BENCH.repeatRuns?.models.filter(model => comparedModels.some(compared => compared.id === model.id)).map(model => (
                  <tr key={model.id}>
                    <th scope="row">{model.id === luna.id ? "GPT-5.6 Luna" : "GLM-5.2"}</th>
                    {model.detectionRates.map((rate, index) => <td key={index}>{(rate * 100).toFixed(1)}%{model.degradedRunIndexes?.includes(index) ? " (output failures)" : ""}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <figcaption className="mt-2 text-sm text-charcoal/70">
            All reported runs for the two compared models. Each percentage uses the
            {" "}{BENCH.defectCases} defect cases as its denominator. The report marks Luna&apos;s fourth
            run as degraded by invalid output: 16 of its 70 attempts are unavailable, including
            five clean cases. Its full observed detection range is 21.1 percentage points.
            That run remains part of the comparison.
          </figcaption>
        </figure>
        <p>
          Luna&apos;s and GLM&apos;s results overlap across these runs. The first run therefore does not
          establish a stable detection ranking. The report uses unconstrained routing, meaning the
          upstream provider is not fixed. Its separate provider-pinned results describe different
          routing conditions and must not be substituted into this comparison.
        </p>
        <p>
          The <a href="/bench/postil-model-bench.json">aggregate report</a> identifies the binary,
          fixture corpus and evaluator behind these figures. The
          {" "}<Link href="/bench#run-the-suite">suite instructions</Link> explain how to run the harness.
          Choosing a reviewer for a repository also requires evidence that its findings explain real
          defects and that its gate decisions fit that repository&apos;s policy. A high location score
          supplies neither of those judgments.
        </p>
      </div>
    </div>
  );
}
