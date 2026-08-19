import benchData from "@/data/bench-results.json";

export interface BenchModelResult {
  id: string;
  unreachable?: boolean;
  detectionRate?: number;
  gateVerdictCorrectness?: number;
  falsePositives?: number;
  cleanCasesSilent?: number;
  cleanCases?: number;
  unscoredCases: number;
  casesRun: number;
  totalCostUsd?: number;
  meanCostUsdPerReview?: number;
  latencyMsP50?: number;
  latencyMsP95?: number;
  pinnedProviderContract?: {
    provider: string;
    runs: number;
    detectionRate: number;
    gateVerdictCorrectness: number;
    falsePositives: number;
    totalCostUsd: number;
    latencyMsP95: number;
  };
}

export interface BenchResults {
  generatedAt: string;
  cliVersion: string;
  fixtureCorpusSha256: string;
  evaluatorSha256: string;
  benchmarkedBinarySha256: string;
  defectCases: number;
  cleanCases: number;
  models: BenchModelResult[];
}

export const BENCH: BenchResults = benchData as BenchResults;

/** Counts and figures quoted in prose are derived here rather than typed, so a
 * refreshed report cannot leave the surrounding sentences stating old numbers. */
export const SCORED_MODELS = BENCH.models.filter((model) => !model.unreachable);
export const UNREACHABLE_MODELS = BENCH.models.filter((model) => model.unreachable);

export function benchModel(id: string): BenchModelResult {
  const model = BENCH.models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`no bench row for ${id}`);
  return model;
}

export function secondsLabel(ms: number | undefined): string {
  return ms === undefined ? "\u2014" : `${(ms / 1000).toFixed(1)}s`;
}

export function formatBenchDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function percent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | undefined): string {
  if (value === undefined) return "—";
  return value.toLocaleString("en-GB", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  });
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

const HEADERS = [
  "Model",
  "Detected",
  "Gate correct",
  "Silent on clean",
  "False findings",
  "No envelope",
  "Total cost",
  "p95",
];

export function BenchTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {HEADERS.map((header) => (
              <th
                key={header}
                scope="col"
                className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BENCH.models.map((model) => (
            <tr key={model.id}>
              <td className="border-b border-stone py-3 pr-3 align-top">
                <code className="text-xs text-charcoal/80">{model.id}</code>
              </td>
              {model.unreachable ? (
                <td
                  colSpan={HEADERS.length - 1}
                  className="border-b border-stone py-3 pr-3 align-top text-charcoal/70"
                >
                  No zero-retention endpoint; every request refused before
                  inference.
                </td>
              ) : (
                <>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono font-medium">
                    {percent(model.detectionRate)}
                  </td>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                    {percent(model.gateVerdictCorrectness)}
                  </td>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                    {model.cleanCasesSilent}/{model.cleanCases}
                  </td>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                    {model.falsePositives}
                  </td>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                    {model.unscoredCases}
                  </td>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                    {usd(model.totalCostUsd)}
                  </td>
                  <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                    {seconds(model.latencyMsP95)}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
