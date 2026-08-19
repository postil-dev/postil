import type { Metadata } from "next";
import Link from "next/link";

import { BENCH, BenchTable, formatBenchDate } from "@/components/bench-table";

export const metadata: Metadata = {
  title: "Model bench — every model we tested, on one fixture set",
  description:
    "Eighteen models scored on the same 70 review fixtures with the same binary on one afternoon: detection, gate correctness, silence on clean pull requests, cost and latency. Raw report included.",
  alternates: { canonical: "/bench" },
  openGraph: {
    title: "Model bench — every model we tested",
    description:
      "Eighteen models, one fixture set, one binary, one afternoon. Including the ones that did badly.",
    url: "/bench",
    images: ["/opengraph-image"],
  },
};

const REPORT_PATH = "/bench/postil-model-bench.json";

export default function BenchPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16 md:py-20">
      <p className="eyebrow">Resources</p>
      <h1 className="serif-display mt-4 text-4xl md:text-5xl">Model bench.</h1>
      <p className="mt-6 text-lg text-ink-soft">
        Every model we have scored against the current fixture set, including
        the ones that did badly and the one that could not be reached at all.
        One corpus, one binary, one afternoon, so the rows are comparable to
        each other.
      </p>

      <div className="prose-postil mt-10">
        <p>
          Generated {formatBenchDate(BENCH.generatedAt)} with{" "}
          {BENCH.cliVersion}. {BENCH.defectCases} fixtures carry a seeded
          defect and {BENCH.cleanCases} are clean pull requests where the
          correct review is silence. Each model saw all{" "}
          {BENCH.defectCases + BENCH.cleanCases} once.
        </p>
      </div>

      <div className="mt-8">
        <BenchTable />
      </div>

      <div className="prose-postil mt-10">
        <p className="text-sm">
          <a href={REPORT_PATH} className="text-rust underline" download>
            Download the raw report
          </a>{" "}
          (JSON). It carries the fixture-corpus, evaluator and binary digests,
          so you can tell whether any other table is measuring the same thing.
        </p>
      </div>

      <div className="prose-postil mt-14">
        <h2>What the columns mean</h2>
        <p>
          <strong>Detected</strong> is the share of seeded defects the model
          flagged. <strong>Gate correct</strong> is how often the merge gate
          blocked exactly when it should have, which is the number that decides
          whether a review costs someone a merge.{" "}
          <strong>Silent on clean</strong> counts the clean pull requests the
          model left alone. <strong>False findings</strong> counts findings
          raised against no defect. <strong>No envelope</strong> counts runs
          that never produced valid structured output, which fail closed rather
          than passing unreviewed code.
        </p>

        <h2>Read the column, not the decimal</h2>
        <p>
          Each figure is one run of a non-deterministic model. We ran two
          models four times each to measure how much that matters: detection
          rate moved over roughly nine percentage points for a single unchanged
          model, which is wider than the gap between most rows in the table.
          Treat differences under about five points as noise.
        </p>
        <p>
          Gate correctness and silence on clean pull requests were far steadier
          across repeats, and they separate the models that detection rate
          cannot. If you take one thing from this table, take that: the
          headline metric is the least useful one on it.
        </p>

        <h2>Cost is not the sticker price</h2>
        <p>
          Total cost here is what the run actually billed, not a rate card. How
          much a model reasons before answering moves it far more than its
          per-token price does. The cheapest model per token in this table
          emitted more than half a million completion tokens to finish the set;
          the cheapest model per <em>review</em> emitted thirty thousand and
          scored higher. Price the work, not the tokens.
        </p>

        <h2>Routing changes the answer</h2>
        <p>
          The rows above come from screening runs, which let the router pick
          any endpoint. Hosted reviews cannot do that: they require a
          zero-retention endpoint, pin one upstream provider, and apply a price
          ceiling. Re-running two models under that contract moved the numbers
          enough to change which one we chose.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Model, pinned</th>
              <th scope="col">Detected</th>
              <th scope="col">Gate correct</th>
              <th scope="col">p95 screening</th>
              <th scope="col">p95 pinned</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>openai/gpt-5.6-luna</code> on Azure</td>
              <td>89.5%</td>
              <td>85.5%</td>
              <td>16.8s</td>
              <td>17.6s</td>
            </tr>
            <tr>
              <td><code>moonshotai/kimi-k2.7-code</code> on CoreWeave</td>
              <td>94.7%</td>
              <td>85.5%</td>
              <td>18.5s</td>
              <td>58.2s</td>
            </tr>
          </tbody>
        </table>
        <p>
          One model was unaffected; the other lost its entire latency
          advantage, because the endpoint the router had been choosing for it
          was not one a zero-retention deployment can use. If you are picking a
          model for a privacy-constrained deployment, measure it on the route
          you are allowed to take, not the cheapest one available.
        </p>

        <h2>What this cannot tell you</h2>
        <p>
          These are seeded defects on synthetic pull requests. A capable model
          can saturate them, so a high score shows that a model handles the
          review pipeline and obvious bugs at the stated cost, not that it will
          find the subtle bug in your codebase. The clean fixtures are the more
          transferable half: a model that cannot stay quiet here will not stay
          quiet on your diffs either.
        </p>
        <p>
          These are our fixtures, and we build the product they score. Read the{" "}
          <Link href="/blog/ai-code-review-benchmarks" className="text-rust underline">
            five-point test for benchmarks
          </Link>{" "}
          and apply it to this page too. The reproduction command below is the
          honest answer to that problem: run it yourself.
        </p>

        <h2>Run it yourself</h2>
        <p>
          The harness is in the{" "}
          <a
            href="https://github.com/postil-dev/postil-cli"
            rel="noopener noreferrer"
            className="text-rust underline"
          >
            CLI repository
          </a>{" "}
          under <code>bench/</code>. Live mode spends real inference tokens and
          never prints your key.
        </p>
        <pre tabIndex={0} aria-label="Code sample">
          <code>{`cargo build --release
cd bench && bun install --frozen-lockfile
export MODEL_API_KEY=...
REVIEW_MODEL=openai/gpt-5.6-luna \\
  bun run bench:live -- --json-out .runs/luna.json`}</code>
        </pre>
        <p>
          One model per run. Compare only against runs whose{" "}
          <code>fixtureCorpusSha256</code> and <code>evaluatorSha256</code>{" "}
          match yours; a different corpus is a different test.
        </p>
      </div>

      <div className="prose-postil mt-14 text-sm">
        <p>
          Fixture corpus <code>{BENCH.fixtureCorpusSha256.slice(0, 16)}</code>,
          evaluator <code>{BENCH.evaluatorSha256.slice(0, 16)}</code>, binary{" "}
          <code>{BENCH.benchmarkedBinarySha256.slice(0, 16)}</code>.{" "}
          <Link href="/docs/models" className="text-rust underline">
            Model catalogue and local inference
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
