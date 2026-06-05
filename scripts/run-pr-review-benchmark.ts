#!/usr/bin/env tsx
import { writeFile } from "node:fs/promises";
import {
  formatPrReviewBenchmarkReport,
  loadPrReviewBenchmarkManifest,
  runPrReviewBenchmark,
} from "../src/benchmarks/pr-review-harness";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const jsonOutIndex = args.indexOf("--json-out");
  const jsonOut = jsonOutIndex === -1 ? undefined : args[jsonOutIndex + 1];
  const manifestPath =
    args.find((arg) => !arg.startsWith("--") && arg !== jsonOut) ??
    "tests/fixtures/pr-review-benchmark/cases.json";

  const manifest = await loadPrReviewBenchmarkManifest(manifestPath);
  const report = await runPrReviewBenchmark(manifest.cases, {
    keepRuns: process.env.POSTIL_BENCHMARK_KEEP_RUNS === "1",
  });

  const jsonReport = JSON.stringify(report, null, 2);
  if (jsonOut) {
    await writeFile(jsonOut, `${jsonReport}\n`);
  }

  console.log(json ? jsonReport : formatPrReviewBenchmarkReport(report));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
