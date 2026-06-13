import { StatusIcon } from "@/components/status-icon";

export type Cell =
  | { kind: "yes"; note?: string }
  | { kind: "no"; note?: string }
  | { kind: "partial"; note?: string }
  | { kind: "text"; note: string };

export interface ComparisonRow {
  feature: string;
  cells: Cell[];
}

function CellView({ cell }: { cell: Cell }) {
  if (cell.kind === "text") {
    return <span className="text-ink-soft">{cell.note}</span>;
  }
  const icon =
    cell.kind === "yes" ? "pass" : cell.kind === "no" ? "error" : "warn";
  const label =
    cell.kind === "yes" ? "Yes" : cell.kind === "no" ? "No" : "Partial";
  return (
    <span className="inline-flex items-start gap-1.5">
      <StatusIcon kind={icon} size={15} className="mt-0.5 shrink-0" />
      <span>
        {cell.note ? (
          <>
            <span className="sr-only">{label}. </span>
            <span className="text-ink-soft">{cell.note}</span>
          </>
        ) : (
          <span className="text-ink-soft">{label.toLowerCase()}</span>
        )}
      </span>
    </span>
  );
}

/**
 * Responsive feature-comparison matrix. Columns: the first is the feature
 * name, the rest are products. Renders as a table on md+ and stacked cards
 * on small screens.
 */
export function ComparisonTable({
  columns,
  rows,
  caption,
}: {
  columns: string[];
  rows: ComparisonRow[];
  caption?: string;
}) {
  return (
    <div className="card overflow-hidden">
      {/* Table for md and up */}
      <table className="hidden w-full border-collapse text-sm md:table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-charcoal text-left">
            <th scope="col" className="px-5 py-3 font-semibold text-charcoal">
              Capability
            </th>
            {columns.map((col, i) => (
              <th
                scope="col"
                key={col}
                className={`px-5 py-3 font-semibold ${
                  i === 0 ? "bg-gate/10 text-charcoal" : "text-charcoal/70"
                }`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.feature} className="border-b border-stone last:border-b-0">
              <th
                scope="row"
                className="px-5 py-3 text-left font-medium text-charcoal"
              >
                {row.feature}
              </th>
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={`px-5 py-3 align-top ${i === 0 ? "bg-gate/5" : ""}`}
                >
                  <CellView cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Stacked cards for small screens */}
      <div className="divide-y divide-stone md:hidden">
        {rows.map((row) => (
          <div key={row.feature} className="p-5">
            <p className="font-medium text-charcoal">{row.feature}</p>
            <dl className="mt-3 space-y-2 text-sm">
              {row.cells.map((cell, i) => (
                <div key={i} className="flex gap-3">
                  <dt
                    className={`w-28 shrink-0 font-mono text-xs ${
                      i === 0 ? "text-gate" : "text-charcoal/60"
                    }`}
                  >
                    {columns[i]}
                  </dt>
                  <dd>
                    <CellView cell={cell} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
