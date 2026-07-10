import benchData from "@/data/bench-results.json";

interface BenchModelResult {
  id: string;
  detectionRate: number;
  falsePositives: number;
  casesRun: number;
  meanCostUsdPerReview: number;
  totalCostUsd?: number;
  meanDurationMs: number;
}

interface BenchResults {
  generatedAt: string;
  cliVersion: string;
  sourceRun?: string;
  models: BenchModelResult[];
}

const data = benchData as BenchResults;

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function formatCost(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function totalCost(m: BenchModelResult): number {
  return m.totalCostUsd ?? m.meanCostUsdPerReview * m.casesRun;
}

export function BenchResultsSection() {
  if (data.models.length === 0) {
    return (
      <p className="text-charcoal/70">
        First measured sweep pending. The bench harness run publishes here.
      </p>
    );
  }

  return (
    <div>
      <p className="text-sm text-charcoal/70">
        Generated {data.generatedAt} with postil-cli {data.cliVersion}.
        {data.sourceRun ? (
          <>
            {" "}
            <a href={data.sourceRun} className="underline" target="_blank" rel="noreferrer">
              Workflow run and artifact
            </a>
            .
          </>
        ) : null}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                Model
              </th>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                Cost / review
              </th>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                Total cost
              </th>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                Detection rate
              </th>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                False positives
              </th>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                Cases run
              </th>
              <th scope="col" className="border-b border-charcoal py-2 pr-3 text-left font-semibold text-charcoal">
                Mean duration
              </th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.id}>
                <td className="border-b border-stone py-3 pr-3 align-top">
                  <code className="text-xs text-charcoal/80">{m.id}</code>
                </td>
                <td className="border-b border-stone py-3 pr-3 align-top font-mono font-medium">
                  {formatCost(m.meanCostUsdPerReview)}
                </td>
                <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                  {formatCost(totalCost(m))}
                </td>
                <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                  {formatPercent(m.detectionRate)}
                </td>
                <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                  {m.falsePositives}
                </td>
                <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                  {m.casesRun}
                </td>
                <td className="border-b border-stone py-3 pr-3 align-top font-mono">
                  {formatDuration(m.meanDurationMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
