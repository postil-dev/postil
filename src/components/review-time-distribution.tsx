import { formatMs } from "@/components/review-status";

export interface DurationBin {
  fromMs: number;
  toMs: number;
  count: number;
}

export function buildDurationBins(durations: readonly number[], binCount = 5): DurationBin[] {
  const values = durations.filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return [];
  const observedMinimum = Math.min(...values);
  const maximum = Math.max(...values);
  const minimum = observedMinimum === maximum ? 0 : observedMinimum;
  const width = Math.max((maximum - minimum) / binCount, 1);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    fromMs: minimum + width * index,
    toMs: index === binCount - 1 ? maximum : minimum + width * (index + 1),
    count: 0,
  }));
  for (const duration of values) {
    const index = Math.min(Math.floor((duration - minimum) / width), binCount - 1);
    bins[index]!.count += 1;
  }
  return bins;
}

export function ReviewTimeDistribution({ durations }: { durations: readonly number[] }) {
  const validDurations = durations.filter((value) => Number.isFinite(value) && value > 0);
  const bins = buildDurationBins(validDurations);
  if (bins.length === 0) return null;
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1);
  const sorted = [...validDurations].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const minimum = bins[0]!.fromMs;
  const maximum = bins.at(-1)!.toMs;
  const medianPosition =
    maximum > minimum ? ((median - minimum) / (maximum - minimum)) * 100 : 50;
  const description = bins
    .map(
      (bin) =>
        `${bin.count} reviews from ${formatMs(bin.fromMs)} to ${formatMs(bin.toMs)}`,
    )
    .join("; ");

  return (
    <details className="group mt-5 border-t border-stone/60 pt-3">
      <summary className="cursor-pointer list-none text-xs font-medium text-charcoal/70 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gate">
        <span className="inline-flex items-center gap-1.5">
          <svg
            className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          View distribution
        </span>
      </summary>
      <div className="mt-4">
        <div
          className="relative flex h-20 items-end gap-2 border-b border-stone/80"
          role="img"
          aria-label={`Review-time distribution across ${validDurations.length} reviews. ${description}`}
        >
          {bins.map((bin, index) => (
            <div
              key={`${bin.fromMs}-${index}`}
              className="group/bin relative h-full flex-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gate"
              role="img"
              tabIndex={0}
              aria-label={`${formatMs(bin.fromMs)} to ${formatMs(bin.toMs)}: ${bin.count} reviews, ${Math.round((bin.count / validDurations.length) * 100)} percent`}
              title={`${bin.count} reviews · ${formatMs(bin.fromMs)}–${formatMs(bin.toMs)}`}
            >
              <div
                className="absolute inset-x-0 bottom-0 rounded-t-[2px] bg-gate/65"
                style={{
                  height: `${Math.max((bin.count / maxCount) * 100, bin.count > 0 ? 5 : 1)}%`,
                }}
              />
            </div>
          ))}
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-rust"
            style={{ left: `${Math.min(Math.max(medianPosition, 0), 100)}%` }}
            aria-hidden="true"
            title={`Median ${formatMs(median)}`}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-charcoal/70">
          <span>{formatMs(bins[0]!.fromMs)}</span>
          <span>{formatMs(bins.at(-1)!.toMs)}</span>
        </div>
        <p className="mt-2 text-[11px] text-charcoal/70">
          {validDurations.length} reviews with recorded engine time. The rust marker is the{" "}
          {formatMs(median)} median.
        </p>
      </div>
    </details>
  );
}
