/**
 * Shared confidence-distribution chart: a point at each of the five
 * confidence buckets, connected by a thin line. Used on the homepage
 * (silence-rate card) and on /how-it-works#silence-methodology so the
 * methodology section can point at the same figure instead of a dangling
 * "above."
 *
 * Data source: measured, not hand-tuned. See the comment above the
 * homepage usage for provenance; when a newer run supersedes this,
 * replace `CONFIDENCE_BUCKETS` (and the homepage's silence-rate figures)
 * together from that run's aggregate.
 */
export interface ConfidenceBucket {
  bucket: string;
  count: number;
}

export const CONFIDENCE_BUCKETS: ConfidenceBucket[] = [
  { bucket: "0.0–0.2", count: 0 },
  { bucket: "0.2–0.4", count: 0 },
  { bucket: "0.4–0.6", count: 0 },
  { bucket: "0.6–0.8", count: 23 },
  { bucket: "0.8–1.0", count: 34 },
];

const AXIS_LABELS = ["0.0", "0.2", "0.4", "0.6", "0.8", "1.0"];

export const CAPTION_TEXT =
  "57 shipped findings across 126 recently merged public pull requests, " +
  "June 2026 — 23 at 0.6–0.8 confidence, 34 at 0.8–1.0. None below 0.6.";

interface ConfidenceChartProps {
  buckets?: ConfidenceBucket[];
  /** "lg" for the homepage card, "sm" for the denser methodology layout. */
  size?: "lg" | "sm";
  className?: string;
  /**
   * Render the caption inside the chart (default). Set false when the
   * caller supplies its own <figcaption> around the chart so the caption
   * text isn't duplicated or mis-nested.
   */
  showCaption?: boolean;
}

/**
 * Point-plot of shipped findings by confidence bucket: one marker per
 * bucket midpoint, joined by a thin line. Inline SVG so the same markup
 * scales cleanly between the homepage card and the methodology section.
 */
export function ConfidenceChart({
  buckets = CONFIDENCE_BUCKETS,
  size = "lg",
  className,
  showCaption = true,
}: ConfidenceChartProps) {
  const max = Math.max(...buckets.map((b) => b.count));
  const yTicks = [0, Math.round(max / 2), max];

  const width = 320;
  // Extra bottom band holds the x-axis tick labels inside the SVG, so they
  // share the plot's coordinate system and can never drift from the bucket
  // boundaries the way a separate HTML flex row can.
  const axisBand = 14;
  const height = (size === "lg" ? 140 : 110) + axisBand;
  const padLeft = 26;
  const padRight = 10;
  const padTop = 18;
  const padBottom = 10 + axisBand;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const points = buckets.map((b, i) => {
    const x = padLeft + (plotW * (i + 0.5)) / buckets.length;
    const y = padTop + plotH - (max ? (b.count / max) * plotH : 0);
    return { ...b, x, y };
  });

  const linePath = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className={className}>
      <p className="font-mono text-xs text-charcoal/70">
        y: findings shipped · x: finding confidence
      </p>
      <div
        role="img"
        aria-label={`Point chart. Y axis: findings shipped, 0 to ${max}. X axis: finding confidence, buckets of 0.2 from 0.0 to 1.0. Values: ${buckets
          .map((b) => `${b.count} findings at ${b.bucket}`)
          .join("; ")}. Every shipped finding was at 0.6 confidence or higher.`}
      >
        {/* Fixed max-width wrapper: the axis-label row below is plain flex
            markup, not SVG, so it needs the same width cap as the chart
            or it stretches to fill wide containers (e.g. the two-column
            methodology card) while the plot stays put. */}
        <div style={{ maxWidth: `${width + 28}px` }}>
          <div className="mt-3 flex gap-2">
            {/* y-axis ticks, high to low, matching the plot row below */}
            <div
              className="flex w-5 flex-col justify-between pb-[1px] text-right font-mono text-[10px] text-charcoal/70"
              style={{ height: `${height}px` }}
            >
              {[...yTicks].reverse().map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="flex-1 border-l border-stone pl-2"
              style={{ height: `${height}px`, maxWidth: `${width}px` }}
              aria-hidden="true"
            >
              {/* gridlines at each y tick */}
              {yTicks.map((t) => {
                const y = padTop + plotH - (max ? (t / max) * plotH : 0);
                return (
                  <line
                    key={t}
                    x1={padLeft}
                    x2={width - padRight}
                    y1={y}
                    y2={y}
                    stroke="var(--color-stone)"
                    strokeWidth={1}
                  />
                );
              })}
              {/* connecting line */}
              <polyline
                points={linePath}
                fill="none"
                stroke="var(--color-gate)"
                strokeWidth={1.5}
              />
              {/* count labels */}
              {points.map((p) => (
                <text
                  key={`label-${p.bucket}`}
                  x={p.x}
                  y={p.y - 8}
                  textAnchor="middle"
                  className="font-mono"
                  fontSize={10}
                  fill="var(--color-charcoal)"
                  fillOpacity={0.7}
                >
                  {p.count > 0 ? p.count : ""}
                </text>
              ))}
              {/* markers */}
              {points.map((p, i) => (
                <circle
                  key={p.bucket}
                  cx={p.x}
                  cy={p.y}
                  r={4}
                  fill="var(--color-rust)"
                  fillOpacity={0.5 + i * 0.12}
                  stroke="var(--color-rust)"
                  strokeWidth={1}
                />
              ))}
              {/* x-axis tick labels at the exact bucket boundaries */}
              {AXIS_LABELS.map((label, i) => (
                <text
                  key={label}
                  x={padLeft + (plotW * i) / (AXIS_LABELS.length - 1)}
                  y={height - 3}
                  textAnchor={
                    i === 0
                      ? "start"
                      : i === AXIS_LABELS.length - 1
                        ? "end"
                        : "middle"
                  }
                  className="font-mono"
                  fontSize={10}
                  fill="var(--color-charcoal)"
                  fillOpacity={0.7}
                >
                  {label}
                </text>
              ))}
            </svg>
          </div>
          <p className="mt-1 ml-7 text-center font-mono text-[10px] text-charcoal/70">
            finding confidence
          </p>
        </div>
      </div>
      {showCaption && (
        <p className="mt-4 font-mono text-[11px] text-charcoal/70">
          {CAPTION_TEXT}
        </p>
      )}
    </div>
  );
}
