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
const attemptedCases = BENCH.defectCases + BENCH.cleanCases;
const lunaRun = caseEvidence.runs.find(run => run.model === luna.id)!;
const glmRun = caseEvidence.runs.find(run => run.model === glm.id)!;
const lunaRepeat = BENCH.repeatRuns!.models.find(model => model.id === luna.id)!;
const lunaRepeatRange = ((Math.max(...lunaRepeat.detectionRates) - Math.min(...lunaRepeat.detectionRates)) * 100).toFixed(1);
const lunaClean = cleanBank.models.find(model => model.model === luna.id)!;
const glmClean = cleanBank.models.find(model => model.model === glm.id)!;
function count(rate: number | undefined, denominator: number): number {
  return Math.round((rate ?? 0) * denominator);
}
function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export default function LeastUsefulNumberArticle() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16 md:py-20">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd(post)) }} />
      <BlogArticleHeader post={post} />
      <div className="prose-postil blog-prose mt-10">
        <p>
          Detection credit goes to a defect case when at least one finding overlaps the planted
          bug&apos;s location, and each case earns at most one. In the
          {" "}<Link href="/bench">Postil screening benchmark</Link>, GPT-5.6 Luna receives it on
          {" "}{count(luna.detectionRate, BENCH.defectCases)} of {BENCH.defectCases} defect cases;
          GLM-5.2 receives it on {count(glm.detectionRate, BENCH.defectCases)}.
        </p>
        <p>
          Of the numbers this benchmark reports, this single-run location-detection count is the least
          useful standalone number for choosing a reviewer, because it measures line overlap alone. A
          comment on the right lines can receive credit while explaining the wrong problem, and a
          location match does not guarantee that a model assigns the severity that produces the correct
          merge decision.
        </p>
        <p>
          A fixture is a prepared change with known files, contracts, and an expected outcome. The
          historical screening run submits {attemptedCases} fixtures: {BENCH.defectCases} defect cases
          built around a known faulty file and line range, and {BENCH.cleanCases} clean cases that need
          no finding under their supplied code and contracts.
        </p>
        <h2>Headline screening results</h2>
        <p>
          This run uses unconstrained provider routing, meaning the upstream provider serving each
          request is not fixed. An attempted case is any fixture submitted to the review pipeline; it is
          either scored, yielding a usable review to grade, or unavailable, yielding none. A gate
          verdict is the pass or fail decision the review&apos;s findings produce under the
          benchmark&apos;s severity policy; the benchmark&apos;s gate is error-only, so an error finding
          blocks a change and warnings alone let it pass.
        </p>
        <div className="overflow-x-auto">
          <table>
            <caption>One screening run per model, using unconstrained provider routing</caption>
            <thead><tr><th scope="col">Measurement</th><th scope="col">GPT-5.6 Luna</th><th scope="col">GLM-5.2</th><th scope="col">Denominator</th></tr></thead>
            <tbody>
              <tr><th scope="row">Defect cases with a location match</th>{comparedModels.map(model => <td key={model.id}>{count(model.detectionRate, BENCH.defectCases)}</td>)}<td>{BENCH.defectCases} defect cases</td></tr>
              <tr><th scope="row">Correct gate verdicts / scored cases</th>{comparedModels.map(model => <td key={model.id}>{count(model.gateVerdictCorrectness, model.casesRun - model.unscoredCases)}</td>)}<td>Scored cases ({luna.casesRun - luna.unscoredCases} for Luna, {glm.casesRun - glm.unscoredCases} for GLM)</td></tr>
              <tr><th scope="row">Cases without a scored result</th>{comparedModels.map(model => <td key={model.id}>{model.unscoredCases}</td>)}<td>{attemptedCases} attempted cases</td></tr>
              <tr><th scope="row">Recorded run cost</th>{comparedModels.map(model => <td key={model.id}>${model.totalCostUsd!.toFixed(4)}</td>)}<td>one {attemptedCases}-case benchmark run</td></tr>
              <tr><th scope="row">95th-percentile case latency</th>{comparedModels.map(model => <td key={model.id}>{secondsLabel(model.latencyMsP95)}</td>)}<td>Scored cases&apos; final invocation</td></tr>
            </tbody>
          </table>
        </div>
        <p>
          These totals cover one benchmark run, not a hosted subscription or a typical pull request.
          The 95th-percentile latency times each scored case&apos;s final invocation, from diff
          preparation to construction of the result, including model calls and internal repairs; it
          excludes unavailable cases, earlier attempts, retry backoff, process startup, and the
          surrounding CI or developer workflow.
        </p>
        <p>
          GLM&apos;s one unscored case is a cache-expiry change that returns milliseconds where seconds are required. Its output is
          an operational error labeled <code>review/invalidOutput</code>, so the pipeline has no usable
          review to score; the label does not identify the underlying cause. The case stays in the
          {" "}{attemptedCases} attempted cases, earns no detection credit, and drops out of gate scoring,
          leaving GLM with {glm.casesRun - glm.unscoredCases} scored cases.
        </p>
        <h2>Repeated runs and provider routing</h2>
        <p>The headline run is one of four on the same corpus, and the four do not agree.</p>
        <div className="overflow-x-auto">
          <table>
            <caption>Location-detection rates across repeated runs (denominator: {BENCH.defectCases} defect cases per run)</caption>
            <thead><tr><th scope="col">Model</th><th scope="col">Run 1</th><th scope="col">Run 2</th><th scope="col">Run 3</th><th scope="col">Run 4</th></tr></thead>
            <tbody>
              {BENCH.repeatRuns?.models.filter(model => comparedModels.some(compared => compared.id === model.id)).map(model => (
                <tr key={model.id}>
                  <th scope="row">{model.id === luna.id ? "GPT-5.6 Luna" : "GLM-5.2"}</th>
                  {model.detectionRates.map((rate, index) => <td key={index}>{percent(rate)}{model.degradedRunIndexes?.includes(index) ? " (output failures)" : ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          The headline run&apos;s rates match Run 1: {count(luna.detectionRate, BENCH.defectCases)} of
          {" "}{BENCH.defectCases} matches is {percent(luna.detectionRate!)}, and
          {" "}{count(glm.detectionRate, BENCH.defectCases)} of {BENCH.defectCases} is {percent(glm.detectionRate!)}.
          In Run 4, Luna degrades because of invalid output: 16 of its 70 attempts are unavailable,
          including five clean cases; the remaining eleven are defect cases that earn no detection
          credit. Luna&apos;s observed detection range is {lunaRepeatRange} percentage
          points across its four runs.
        </p>
        <p>
          Luna&apos;s and GLM&apos;s detection rates overlap across these runs, so the first run does not
          establish a stable ranking between the two models. These runs all use unconstrained provider
          routing; separate provider-pinned results, where the upstream provider is fixed, describe
          different conditions and must not be substituted into this comparison.
        </p>
        <h2>Gate outcomes and severity policy</h2>
        <p>
          A gate is an automated rule that turns review findings into a pass or fail merge decision.
          An authored verdict is the pass or fail decision
          that a fixture&apos;s author expects under this severity policy. Gate correctness asks whether
          the review result agrees with that authored verdict. A model can find a defect&apos;s exact
          location and still assign a severity, or a finding kind, that produces the wrong gate action;
          the gate reads both.
        </p>
        <div className="overflow-x-auto">
          <table>
            <caption>Gate outcomes across all {attemptedCases} attempted cases relative to authored verdicts</caption>
            <thead><tr><th scope="col">Outcome</th><th scope="col">GPT-5.6 Luna</th><th scope="col">GLM-5.2</th><th scope="col">Denominator</th></tr></thead>
            <tbody>
              {([
                ["correctPass", "Correct pass"], ["correctBlock", "Correct block"],
                ["falsePass", "Pass when the fixture requires a block"],
                ["falseBlock", "Block when the fixture expects a pass"],
                ["unavailable", "Unavailable review result"],
              ] as const).map(([key, label]) => <tr key={key}><th scope="row">{label}</th>{caseEvidence.runs.map(run => <td key={run.model}>{run.counts[key]}</td>)}<td>{caseEvidence.runs[0]!.results.length} attempted cases</td></tr>)}
            </tbody>
          </table>
        </div>
        <p>
          The largest operational difference between the models appears in cases that should block
          under benchmark policy: Luna passes {lunaRun.counts.falsePass} of these changes, GLM passes
          {" "}{glmRun.counts.falsePass}.
        </p>
        <p>
          In the archive-deletion case, both models identify the replacement of <code>archiveFile</code>
          {" "}with <code>storage.delete</code> but label the finding a warning. The fixture requires
          preserving the recovery copy and assigns error severity; because the gate only blocks on
          errors, both models let a change pass when the fixture expects a block.
        </p>
        <p>
          Disagreement also runs the other way. In the disabled-timeout fixture, the authored verdict is
          a warning, which should pass an error-only gate. Both models label the finding an error, so
          both gates block the change.
        </p>
        <p>
          These outcomes record agreement with this benchmark&apos;s severity policy, not a universal
          rule about which risks every repository must accept. The
          {" "}<a href="/bench/screening-0.8.26-case-evidence.json">case evidence</a> records the
          authored targets, source excerpts, model findings, and gate decisions for each case.
        </p>
        <h2>Clean cases across two experiments</h2>
        <p>
          A silent final review is a final review result that contains no findings. A suppressed
          candidate is a concern a model raises internally that Postil&apos;s pipeline discards before
          producing the final review. Because suppression happens inside the pipeline, a silent final
          review does not by itself show whether a model generated any candidate concern at all. The
          benchmark tests clean behavior in two separate experiments: the historical
          {" "}{BENCH.cleanCases}-case sample and an expanded {cleanBank.fixtures.length}-case bank;
          neither separates the two models on final review silence.
        </p>
        <p>
          The {BENCH.cleanCases} clean cases, drawn from the <Link href="/bench">historical 70-case screening report</Link>,
          include comment and documentation edits, variable and type renames, test maintenance,
          formatting updates, and safe changes to authorization, cache expiry, and concurrent fetching;
          a variable-rename fixture, for example, alters a name while preserving the return value. The
          {" "}<a href="https://github.com/postil-dev/postil-cli/tree/main/bench#readme">fixture suite</a>
          {" "}contains the changes and expected results.
          In this run, both models produce {luna.cleanCasesSilent} silent final reviews out of
          {" "}{BENCH.cleanCases} clean cases, with no findings and no unavailable results. This sample is
          small and curated.
        </p>
        <CleanReviewChart />
        <p>
          The <a href="/bench/screening-0.9.7-clean-bank-v2.json">expanded clean bank</a> adds
          {" "}{cleanBank.fixtures.filter(fixture => fixture.bank === "supplemental").length} executable
          examples to those same {BENCH.cleanCases} cases, forming a separate {cleanBank.fixtures.length}-case
          corpus on a different binary. These additions include extracting a tenant check without
          altering read permissions, preserving a boundary cache-expiry limit, and keeping a zero-valued
          retry setting distinct from an absent one. In one example, replacing an explicit
          null-or-undefined check with <code>config.retries ?? 3</code> preserves zero as a request for
          no retries, where a truthiness check would instead turn zero into three; the fixture tests
          whether a model accepts that simplification under a stated configuration contract.
        </p>
        <CleanReviewChart experiment="expanded" />
        <p>
          Both models see identical fixture inputs in this experiment, with matching evaluator and
          binary hashes, three concurrent cases, no outer retries, and disabled provider fallbacks. Luna
          uses the Azure EU provider route; GLM uses the Z.AI route.
        </p>
        <p>
          The recorded charges are
          {" "}${lunaClean.observedProviderCostUsdDecimal} for Luna and ${glmClean.observedProviderCostUsdDecimal} for
          GLM; these figures describe only this clean-only experiment and must not be substituted for
          the {attemptedCases}-case screening-run costs reported above. This {cleanBank.fixtures.length}-case
          run does not change the {BENCH.defectCases}-defect and {BENCH.cleanCases}-clean denominators of
          the historical report; it measures the complete review pipeline, including suppression, rather
          than whether either model generates any candidate concern at all.
        </p>
        <p>
          Supplied runtime contracts shape these results. In an optional-field fixture without an
          explicit runtime guarantee, Luna retains a compatibility warning about <code>Object.hasOwn</code>
          {" "}in its final review; that warning is not an established false alarm, because the fixture
          leaves runtime support for the method unspecified. The {cleanBank.fixtures.length}-case
          comparison states that runtime guarantee directly in the diff, and the final review stays
          silent. The evidence file keeps the result from the variant without the guarantee so the two
          inputs are not mistaken for repeated runs of the same fixture. One observation per case and
          model, in the {cleanBank.fixtures.length}-case bank, cannot establish a stable false-positive
          rate.
        </p>
        <h2>The extra-findings counter</h2>
        <p>
          The benchmark report records <code>falsePositives: {glm.falsePositives}</code> for GLM. That
          name is misleading. The evaluator awards at most one detection credit per defect case, and
          this counter increments on every additional finding on that case, whether the finding
          duplicates the credited match or raises an unrelated concern; it is an extra-findings counter,
          not a tally of verified false alarms. The
          {" "}<a href="/bench/screening-0.8.26-case-evidence.json">versioned case evidence</a> shows
          that GLM&apos;s {glm.falsePositives} extra findings consist of one duplicate diagnosis and two
          unverified compatibility questions.
        </p>
        <p>
          In the configuration-loader case, the code replaces <code>return defaultConfig</code> with
          {" "}<code>throw err</code> beside a comment that still promises fallback to defaults. GLM
          reports both the misleading comment and the lost fallback behavior at the same line,
          {" "}<code>src/config/load.ts:26</code>. Both reports describe the same seeded fallback-contract
          defect; the second is a duplicate, not a separate bug.
        </p>
        <p>
          In the provider-client case, the seeded defect disables a request timeout. GLM also flags a
          metric rename from <code>provider.request</code> to <code>provider.requests</code> and an
          {" "}<code>Accept</code> header change from <code>application/json</code> to
          {" "}<code>application/vnd.api+json</code>. Its metric warning asserts that existing consumers
          lose data, though the supplied context identifies neither such consumers nor a stable-name
          contract.
          Its header warning holds only if endpoints reject the requested type; the supplied endpoint
          contract does not establish that rejection. Both are compatibility questions, not
          demonstrated failures in the supplied code.
        </p>
        <h2>Choosing a reviewer</h2>
        <p>
          The location-detection score shows only that both models produce findings overlapping the
          seeded defect locations. It does not show whether a model explains a defect correctly, whether it assigns a severity that matches a
          repository&apos;s merge rules, or how consistently it produces usable output across repeated
          runs, and it says nothing about recorded cost or response time.
        </p>
        <p>
          The <a href="/bench/postil-model-bench.json">aggregate report</a> identifies the binary,
          fixture corpus, and evaluator behind these figures, and the
          {" "}<Link href="/bench#run-the-suite">suite instructions</Link> explain how to run the harness.
        </p>
        <p>
          Choosing a code review model for a repository also requires evidence that its findings
          explain real defects and that its gate decisions fit that repository&apos;s own policy. A high
          location-detection score supplies neither of those judgments.
        </p>
      </div>
    </div>
  );
}
