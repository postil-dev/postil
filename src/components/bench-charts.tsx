import { BENCH, benchModel, SCORED_MODELS } from "@/components/bench-table";

// Palette validated against the ivory chart surface for three categorical
// slots: lightness band, chroma floor, CVD separation (worst adjacent ΔE 26.5),
// normal-vision floor (ΔE 29.0) and contrast (all >= 3:1) all pass.
const SERIES = ["#b8431f", "#2a78d6", "#008300"] as const;
const AXIS = "#8d9199";
const GRID = "#e3ded8";
const CONTEXT = "#b6b1aa";
const INK = "#1b2329";
const INK_SOFT = "#3d464d";

function shortName(id: string): string {
  return id.split("/")[1] ?? id;
}

/** Detection rate across repeated runs of one unchanged model. The job is to
 * show that the three distributions overlap, so the runs are drawn as
 * individual marks on one shared scale rather than summarised. */
export function DetectionSpreadChart() {
  const repeats = BENCH.repeatRuns;
  if (!repeats) return null;

  const width = 720;
  const rowHeight = 62;
  const padLeft = 168;
  const padRight = 28;
  const padTop = 34;
  const height = padTop + repeats.models.length * rowHeight + 34;
  const min = 70;
  const max = 100;
  const x = (pct: number) =>
    padLeft + ((pct - min) / (max - min)) * (width - padLeft - padRight);

  const ticks = [70, 75, 80, 85, 90, 95, 100];

  return (
    <figure className="my-8">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Detection rate across four runs of each of three models, showing overlapping ranges"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={x(tick)}
              x2={x(tick)}
              y1={padTop - 10}
              y2={height - 30}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={x(tick)}
              y={height - 12}
              textAnchor="middle"
              fontSize={12}
              fill={AXIS}
              fontFamily="ui-monospace, monospace"
            >
              {tick}%
            </text>
          </g>
        ))}

        {repeats.models.map((model, row) => {
          const y = padTop + row * rowHeight + rowHeight / 2 - 8;
          const degraded = new Set(model.degradedRunIndexes ?? []);
          const rates = model.detectionRates.map((rate) => rate * 100);
          // The spread is a claim about judgement, so a run that failed to
          // produce output on much of the corpus does not set its bounds. It
          // still plots, hollow, so the reader sees it happened.
          // A model whose every run degraded has no judgement to bound, so the
          // bar spans the readings there are rather than Math.min of nothing,
          // which is Infinity and renders the whole row as NaN coordinates.
          const scoredRates = rates.filter((_, index) => !degraded.has(index));
          const bounded = scoredRates.length > 0 ? scoredRates : rates;
          const lo = Math.min(...bounded);
          const hi = Math.max(...bounded);
          const colour = SERIES[row % SERIES.length]!;
          return (
            <g key={model.id}>
              <text
                x={padLeft - 14}
                y={y + 4}
                textAnchor="end"
                fontSize={13}
                fill={INK}
                fontFamily="ui-monospace, monospace"
              >
                {shortName(model.id)}
              </text>
              <line
                x1={x(lo)}
                x2={x(hi)}
                y1={y}
                y2={y}
                stroke={colour}
                strokeWidth={2}
                opacity={0.35}
              />
              {rates.map((rate, index) => (
                <circle
                  key={`${model.id}-${index}`}
                  cx={x(rate)}
                  cy={y}
                  r={6}
                  fill={degraded.has(index) ? "#f7f5f1" : colour}
                  stroke={degraded.has(index) ? colour : "#f7f5f1"}
                  strokeWidth={2}
                >
                  <title>
                    {degraded.has(index)
                      ? `${model.id} run ${index + 1}: ${rate.toFixed(1)}% — most cases produced no valid output`
                      : `${model.id} run ${index + 1}: ${rate.toFixed(1)}% detected`}
                  </title>
                </circle>
              ))}
              {scoredRates.length > 0 ? (
                <text
                  x={x(hi) + 14}
                  y={y + 4}
                  fontSize={12}
                  fill={INK_SOFT}
                  fontFamily="ui-monospace, monospace"
                >
                  {(hi - lo).toFixed(1)} pt spread
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-charcoal/70">
        Each filled dot is one run of the same model against the same 70
        fixtures. The ranges overlap almost completely, which is why a single
        run cannot rank these models. The hollow dot is a run where 16 of 70
        cases produced no valid output: it is shown rather than dropped,
        because discarding bad runs is how a benchmark flatters itself, and
        left out of the spread, which is a claim about judgement rather than
        availability.
      </figcaption>
    </figure>
  );
}

/** Cost against gate-verdict correctness for every scored model. Three models
 * carry the argument and the rest are context, so this is an emphasis chart:
 * one hue each for the three, a recessive grey for the other sixteen. */
export function CostAgainstGateChart() {
  const width = 720;
  const height = 420;
  const padLeft = 58;
  const padRight = 26;
  const padTop = 24;
  const padBottom = 54;

  const highlighted = [
    "openai/gpt-5.6-luna",
    "z-ai/glm-5.2",
    "moonshotai/kimi-k2.7-code",
  ];
  const points = SCORED_MODELS.filter(
    (model) => model.totalCostUsd !== undefined && model.gateVerdictCorrectness !== undefined,
  );

  const costs = points.map((model) => model.totalCostUsd!);
  const logMin = Math.log10(Math.min(...costs));
  const logMax = Math.log10(Math.max(...costs));
  const x = (cost: number) =>
    padLeft +
    ((Math.log10(cost) - logMin) / (logMax - logMin)) * (width - padLeft - padRight);

  const gateMin = 0.6;
  const gateMax = 0.92;
  const y = (gate: number) =>
    padTop + ((gateMax - gate) / (gateMax - gateMin)) * (height - padTop - padBottom);

  const costTicks = [0.05, 0.1, 0.25, 0.5, 1.0];
  const gateTicks = [0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

  return (
    <figure className="my-8">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="Total cost against gate-verdict correctness for every scored model"
      >
        {gateTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y(tick)}
              y2={y(tick)}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={padLeft - 10}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={12}
              fill={AXIS}
              fontFamily="ui-monospace, monospace"
            >
              {Math.round(tick * 100)}%
            </text>
          </g>
        ))}
        {costTicks.map((tick) => (
          <text
            key={tick}
            x={x(tick)}
            y={height - 30}
            textAnchor="middle"
            fontSize={12}
            fill={AXIS}
            fontFamily="ui-monospace, monospace"
          >
            ${tick < 1 ? tick.toFixed(2) : tick.toFixed(2)}
          </text>
        ))}
        <text
          x={(width + padLeft) / 2}
          y={height - 8}
          textAnchor="middle"
          fontSize={12}
          fill={INK_SOFT}
        >
          Cost for all 70 fixtures (log scale)
        </text>

        {points
          .filter((model) => !highlighted.includes(model.id))
          .map((model) => (
            <circle
              key={model.id}
              cx={x(model.totalCostUsd!)}
              cy={y(model.gateVerdictCorrectness!)}
              r={5}
              fill={CONTEXT}
              stroke="#f7f5f1"
              strokeWidth={2}
            >
              <title>{`${model.id}: gate ${(model.gateVerdictCorrectness! * 100).toFixed(1)}%, $${model.totalCostUsd!.toFixed(3)}`}</title>
            </circle>
          ))}

        {highlighted.map((id, index) => {
          const model = benchModel(id);
          if (model.totalCostUsd === undefined || model.gateVerdictCorrectness === undefined) {
            return null;
          }
          const colour = SERIES[index % SERIES.length]!;
          const cx = x(model.totalCostUsd);
          const cy = y(model.gateVerdictCorrectness);
          const labelRight = cx < width - 200;
          return (
            <g key={id}>
              <circle cx={cx} cy={cy} r={8} fill={colour} stroke="#f7f5f1" strokeWidth={2}>
                <title>{`${id}: gate ${(model.gateVerdictCorrectness * 100).toFixed(1)}%, $${model.totalCostUsd.toFixed(3)}`}</title>
              </circle>
              <text
                x={labelRight ? cx + 14 : cx - 14}
                y={cy + 4}
                textAnchor={labelRight ? "start" : "end"}
                fontSize={12.5}
                fill={INK}
                fontFamily="ui-monospace, monospace"
              >
                {shortName(id)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-charcoal/70">
        Gate-verdict correctness against what the run cost, for all{" "}
        {points.length} scored models. Up is better, left is cheaper. The model
        we moved to sits top left: it decides the gate correctly more often than
        anything else measured, for the second-lowest spend on the chart.
      </figcaption>
    </figure>
  );
}
