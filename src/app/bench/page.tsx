import type { Metadata } from "next";
import Link from "next/link";

import {
  CostAgainstGateChart,
  DetectionSpreadChart,
} from "@/components/bench-charts";
import {
  BENCH,
  BenchTable,
  benchModel,
  formatBenchDate,
  secondsLabel,
  SCORED_MODELS,
  UNREACHABLE_MODELS,
} from "@/components/bench-table";

const LUNA = benchModel("openai/gpt-5.6-luna");
const K27 = benchModel("moonshotai/kimi-k2.7-code");

export const metadata: Metadata = {
  title: "Model bench: one fixture set",
  description: `${SCORED_MODELS.length} model results on the same ${BENCH.defectCases + BENCH.cleanCases} review fixtures and binary, with detection, gate correctness, silence on clean pull requests, cost, latency, and raw data.`,
  alternates: { canonical: "/bench" },
  openGraph: {
    title: "Model bench: one fixture set",
    description: `${SCORED_MODELS.length} model results with shared fixtures, binary, and raw data.`,
    url: "/bench",
    images: ["/opengraph-image"],
  },
};

const REPORT_PATH = "/bench/postil-model-bench.json";

function pinnedPercent(value: number | undefined): string {
  return value === undefined ? "Not recorded" : `${(value * 100).toFixed(1)}%`;
}

export default function BenchPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Resources</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">Model bench.</h1>
      <p className="mt-6 text-lg text-ink-soft">
        {SCORED_MODELS.length} scored models and {UNREACHABLE_MODELS.length} unreachable
        model row use the same fixture corpus, evaluator, and binary. The raw
        report records the inputs needed to compare another run with this one.
      </p>

      <section className="mt-12" aria-labelledby="quality-cost-chart-heading">
        <h2
          id="quality-cost-chart-heading"
          className="serif-display text-2xl text-charcoal"
        >
          Quality and total run cost
        </h2>
        <p className="prose-postil mt-2 max-w-2xl">
          Every point uses the same {BENCH.defectCases + BENCH.cleanCases} fixtures:
          {BENCH.defectCases} seeded-defect pull requests and {BENCH.cleanCases} clean
          pull requests. Cost is the USD total for that one screening run, not a
          provider rate card. Gate-verdict correctness excludes cases without a
          valid envelope, which the table records under No envelope. The chart
          describes this fixture corpus and screening route only.
        </p>
        <CostAgainstGateChart />
      </section>

      <section className="mt-10" aria-labelledby="raw-results-heading">
        <h2 id="raw-results-heading" className="serif-display text-2xl text-charcoal">
          Raw results
        </h2>
        <p className="mt-2 text-sm text-charcoal/70">
          The table retains the denominators, validity failures, total cost, and
          p95 latency for every attempted model.
        </p>
        <BenchTable />
      </section>

      <div className="prose-postil mt-14">
        <h2>Interpreting the results</h2>
        <p>
          <strong>Detected</strong> is the share of defect fixtures with a finding
          overlapping the seeded path and line range. The evaluator does not verify the
          diagnosis. The <a href="https://github.com/postil-dev/postil-cli/blob/e6ccd5aba3edb599c0cbd14a42bf6c4cf272969e/bench/src/live.ts#L818" className="text-rust underline">report&apos;s scoring rules</a>{" "}
          define the location match and unmatched-finding count. <strong>Gate correct</strong> is the share of valid envelopes
          whose gate result matches the fixture outcome.{" "}
          <strong>Silent on clean</strong> counts the clean pull requests the
          model left alone. <strong>False findings</strong> counts unmatched envelope findings
          across both clean and defect fixtures. <strong>No envelope</strong> counts fixture
          runs without a valid structured output.
        </p>

        <h2>Repeated screening runs</h2>
        <p>
          The report contains four screening runs for each of three models. The
          chart shows each observed detection rate and marks the degraded run
          separately. These repeated runs use screening routing and do not
          establish a ranking for a different provider route.
        </p>
        <DetectionSpreadChart />

        <h2>Cost measurement</h2>
        <p>
          Total cost is the observed USD charge for one full screening run. It
          includes the model output required for these fixtures and does not
          represent a provider price list or the cost of another corpus.
        </p>

        <h2>Provider route measurements</h2>
        <p>
          The screening results allow routed endpoints. This table records the
          screening p95 latency and the p95 latency observed on the named pinned
          provider routes for two models. A deployment with provider, retention,
          or price constraints needs measurements under the same contract.
        </p>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Provider route measurements">
        <table>
          <thead>
            <tr>
              <th scope="col">Model and pinned provider</th>
              <th scope="col">Detected</th>
              <th scope="col">Gate correct</th>
              <th scope="col">p95 screening</th>
              <th scope="col">p95 pinned</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>openai/gpt-5.6-luna</code> on{" "}
                {LUNA.pinnedProviderContract?.provider}
              </td>
              <td>{pinnedPercent(LUNA.pinnedProviderContract?.detectionRate)}</td>
              <td>{pinnedPercent(LUNA.pinnedProviderContract?.gateVerdictCorrectness)}</td>
              <td>{secondsLabel(LUNA.latencyMsP95)}</td>
              <td>{secondsLabel(LUNA.pinnedProviderContract?.latencyMsP95)}</td>
            </tr>
            <tr>
              <td>
                <code>moonshotai/kimi-k2.7-code</code> on{" "}
                {K27.pinnedProviderContract?.provider}
              </td>
              <td>{pinnedPercent(K27.pinnedProviderContract?.detectionRate)}</td>
              <td>{pinnedPercent(K27.pinnedProviderContract?.gateVerdictCorrectness)}</td>
              <td>{secondsLabel(K27.latencyMsP95)}</td>
              <td>{secondsLabel(K27.pinnedProviderContract?.latencyMsP95)}</td>
            </tr>
          </tbody>
        </table>
        </div>

        <h2>Scope</h2>
        <p>
          The fixtures are synthetic pull requests with seeded defects and clean
          changes. The report measures this review pipeline on those fixtures;
          it does not establish performance on a separate codebase, corpus, or
          provider route.
        </p>
        <p>
          The fixture corpus is maintained with the reviewed system. Read the{" "}
          <Link href="/blog/ai-code-review-benchmarks" className="text-rust underline">
            guide to comparing benchmarks
          </Link>{" "}
          when evaluating this report or another benchmark.
        </p>

        <h2 id="run-the-suite">Run it yourself</h2>
        <p>
          Start with the public{" "}
          <a
            href="https://github.com/postil-dev/postil-cli/blob/main/bench/README.md"
            rel="noopener noreferrer"
            className="text-rust underline"
          >
            CLI benchmark README
          </a>
          . It describes mock mode and live inference. Live mode spends real
          inference tokens.
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`cargo build --release
cd bench && bun install --frozen-lockfile
export MODEL_API_KEY=...
REVIEW_MODEL=openai/gpt-5.6-luna \\
  bun run bench:live -- --json-out .runs/luna.json`}</code>
        </pre>
        <p>
          Run one model per report. Compare only runs whose{" "}
          <code>fixtureCorpusSha256</code> and <code>evaluatorSha256</code>{" "}
          match yours; a different corpus is a different test.
        </p>
      </div>

      <details className="prose-postil mt-14 text-sm">
        <summary className="cursor-pointer font-medium text-charcoal">
          Report identity and reproduction data
        </summary>
        <p>
          Report timestamp {formatBenchDate(BENCH.generatedAt)}; CLI version{" "}
          <code>{BENCH.cliVersion}</code>; fixture corpus{" "}
          <code>{BENCH.fixtureCorpusSha256.slice(0, 16)}</code>; evaluator{" "}
          <code>{BENCH.evaluatorSha256.slice(0, 16)}</code>; binary{" "}
          <code>{BENCH.benchmarkedBinarySha256.slice(0, 16)}</code>.
        </p>
        <p>
          <a href={REPORT_PATH} className="text-rust underline" download>
            Download the raw report (JSON)
          </a>{" "}
          or read the{" "}
          <Link href="/docs/models" className="text-rust underline">
            model catalogue and local inference guide
          </Link>
          .
        </p>
      </details>
    </div>
  );
}
