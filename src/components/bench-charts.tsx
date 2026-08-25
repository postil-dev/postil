"use client";

import { useState, type CSSProperties } from "react";

import {
  BENCH,
  benchModel,
  SCORED_MODELS,
  secondsLabel,
  type BenchModelResult,
} from "@/components/bench-table";

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

const HIGHLIGHTED = [
  "openai/gpt-5.6-luna",
  "z-ai/glm-5.2",
  "moonshotai/kimi-k2.7-code",
] as const;

const ORDINALS = [
  "lowest",
  "second-lowest",
  "third-lowest",
  "fourth-lowest",
  "fifth-lowest",
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentLabel(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function costLabel(value: number): string {
  return `$${value.toFixed(3)}`;
}

interface CostGatePoint {
  model: BenchModelResult;
  name: string;
  cost: number;
  cx: number;
  cy: number;
  colour: string;
  radius: number;
  /** Spoken and shown on the card: every figure the row carries for this model
   * that bears on the trade-off the chart is about. */
  metrics: { label: string; value: string }[];
}

const LABEL_GAP = 14;
const LABEL_CHAR = 7.3; // 12.5px monospace advance width
const LABEL_BAND = 11; // vertical reach of one label line either side of a mark

/** Where a permanent label sits relative to its mark: right of it, else left,
 * else under or over it. A name laid across another mark reads as two things
 * at once, so the first placement clear of every other mark wins. */
function labelPlacement(
  point: CostGatePoint,
  all: CostGatePoint[],
  plotLeft: number,
  plotRight: number,
): { x: number; y: number; anchor: "start" | "end" | "middle" } {
  const span = point.name.length * LABEL_CHAR;
  const clear = (from: number, to: number, baseline: number) =>
    !all.some(
      (other) =>
        other !== point &&
        Math.abs(other.cy - baseline) < LABEL_BAND &&
        other.cx + other.radius > from &&
        other.cx - other.radius < to,
    );

  const right = point.cx + LABEL_GAP;
  if (right + span <= plotRight && clear(right, right + span, point.cy)) {
    return { x: right, y: point.cy + 4, anchor: "start" };
  }
  const left = point.cx - LABEL_GAP;
  if (left - span >= plotLeft && clear(left - span, left, point.cy)) {
    return { x: left, y: point.cy + 4, anchor: "end" };
  }
  const under = point.cy + point.radius + 15;
  if (clear(point.cx - span / 2, point.cx + span / 2, under)) {
    return { x: point.cx, y: under, anchor: "middle" };
  }
  const over = point.cy - point.radius - 10;
  if (clear(point.cx - span / 2, point.cx + span / 2, over)) {
    return { x: point.cx, y: over, anchor: "middle" };
  }
  return { x: right, y: point.cy + 4, anchor: "start" };
}

/** Cost against gate-verdict correctness for every scored model.
 *
 * Decision rules this chart is drawn to, so later edits do not re-litigate
 * them point by point:
 * - Cost runs high to low left to right, so the model a reader should want
 *   sits in the top right corner. A scatter reads best when both axes point
 *   the same way.
 * - No rules across the plot. Nineteen marks on two axes carry the shape on
 *   their own; a single hairline under the plot separates the cost labels
 *   from the marks and is the only line that earns its ink.
 * - Three models carry the argument and the rest are context, so this is an
 *   emphasis chart: one hue each for the three, a recessive grey for the
 *   other sixteen, and a permanent name only on the three the surrounding
 *   prose names.
 * - Detail on demand for the rest: pointer or keyboard on any mark opens one
 *   card carrying the whole row. It floats beside the mark, clamped to the
 *   plot, and drops below the plot on a screen too short to hold it without
 *   covering the mark it describes.
 */
export function CostAgainstGateChart() {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const activeId = hovered ?? focused;

  const width = 720;
  const height = 420;
  const padLeft = 58;
  const padRight = 26;
  const padTop = 24;
  const padBottom = 54;
  const plotBottom = height - padBottom;

  const scored = SCORED_MODELS.filter(
    (model) => model.totalCostUsd !== undefined && model.gateVerdictCorrectness !== undefined,
  );

  const costs = scored.map((model) => model.totalCostUsd!);
  const logMin = Math.log10(Math.min(...costs));
  const logMax = Math.log10(Math.max(...costs));
  // Cheap on the right: the axis is inverted so height and thrift both read as
  // progress towards the top right.
  // Coordinates round to hundredths of a viewBox unit. Math.log10 differs in
  // its last bit between the server runtime and the browser, which is far below
  // a rendered pixel and still enough to fail hydration on the raw value.
  const x = (cost: number) =>
    round2(
      padLeft +
        ((logMax - Math.log10(cost)) / (logMax - logMin)) * (width - padLeft - padRight),
    );

  const gateMin = 0.6;
  const gateMax = 0.92;
  const y = (gate: number) =>
    round2(padTop + ((gateMax - gate) / (gateMax - gateMin)) * (height - padTop - padBottom));

  const costTicks = [0.05, 0.1, 0.25, 0.5, 1.0];
  const gateTicks = [0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

  const points: CostGatePoint[] = scored.map((model) => {
    const cost = model.totalCostUsd!;
    const gate = model.gateVerdictCorrectness!;
    const emphasis = HIGHLIGHTED.indexOf(model.id as (typeof HIGHLIGHTED)[number]);
    const metrics = [
      { label: "Gate correct", value: percentLabel(gate) },
      { label: "Total cost", value: costLabel(cost) },
      ...(model.detectionRate === undefined
        ? []
        : [{ label: "Detected", value: percentLabel(model.detectionRate) }]),
      ...(model.latencyMsP95 === undefined
        ? []
        : [{ label: "p95 latency", value: secondsLabel(model.latencyMsP95) }]),
    ];
    return {
      model,
      name: shortName(model.id),
      cost,
      cx: x(cost),
      cy: y(gate),
      colour: emphasis === -1 ? CONTEXT : SERIES[emphasis % SERIES.length]!,
      radius: emphasis === -1 ? 5 : 8,
      metrics,
    };
  });

  const winner = benchModel("openai/gpt-5.6-luna");
  // Derived so the caption cannot outlive the report it describes.
  const cheaperThanWinner = costs.filter((cost) => cost < winner.totalCostUsd!).length;
  const winnerCostRank = ORDINALS[cheaperThanWinner] ?? `${cheaperThanWinner + 1}th-lowest`;

  const active = points.find((point) => point.model.id === activeId);
  // A mark high in the plot takes its card below it, and the reverse, so the
  // card never sits on the mark it describes or over the edge of the figure.
  const nearTop = active !== undefined && active.cy < height * 0.45;
  // Tab order sweeps the plot the way it reads, most expensive to cheapest,
  // which is left to right on the inverted axis.
  const hitOrder = [...points].sort((first, second) => second.cost - first.cost);

  return (
    <figure className="my-8">
      <div className="relative" onPointerLeave={() => setHovered(null)}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="group"
          aria-label={`Total cost against gate-verdict correctness for ${points.length} scored models. Cost runs from high on the left to low on the right.`}
        >
          {gateTicks.map((tick) => (
            <text
              key={tick}
              x={padLeft - 10}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={12}
              fill={AXIS}
              fontFamily="ui-monospace, monospace"
            >
              {Math.round(tick * 100)}%
            </text>
          ))}
          <line
            x1={padLeft - 12}
            x2={width - padRight}
            y1={plotBottom}
            y2={plotBottom}
            stroke={GRID}
            strokeWidth={1}
          />
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
              ${tick.toFixed(2)}
            </text>
          ))}
          <text
            x={(width + padLeft) / 2}
            y={height - 8}
            textAnchor="middle"
            fontSize={12}
            fill={INK_SOFT}
          >
            Cost for all 70 fixtures, log scale, cheaper to the right
          </text>

          {/* Marks paint context first so the three emphasised models sit on
              top; the hit targets below carry the interaction and their own
              order, which keeps paint order and tab order independent. */}
          {points
            .filter((point) => point.radius === 5)
            .map((point) => (
              <circle
                key={point.model.id}
                cx={point.cx}
                cy={point.cy}
                r={point.radius}
                fill={point.colour}
                stroke="#f7f5f1"
                strokeWidth={2}
                pointerEvents="none"
              />
            ))}
          {points
            .filter((point) => point.radius === 8)
            .map((point) => {
              const label = labelPlacement(point, points, padLeft, width - padRight - 8);
              return (
                <g key={point.model.id} pointerEvents="none">
                  <circle
                    cx={point.cx}
                    cy={point.cy}
                    r={point.radius}
                    fill={point.colour}
                    stroke="#f7f5f1"
                    strokeWidth={2}
                  />
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor={label.anchor}
                    fontSize={12.5}
                    fill={INK}
                    fontFamily="ui-monospace, monospace"
                  >
                    {point.name}
                  </text>
                </g>
              );
            })}

          {active ? (
            <circle
              cx={active.cx}
              cy={active.cy}
              r={active.radius + 5}
              fill="none"
              stroke={active.colour}
              strokeWidth={1.5}
              pointerEvents="none"
            />
          ) : null}

          {hitOrder.map((point) => (
            <circle
              key={point.model.id}
              cx={point.cx}
              cy={point.cy}
              r={12}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${point.model.id}. ${point.metrics
                .map((metric) => `${metric.label} ${metric.value}`)
                .join(". ")}.`}
              // Touch drives the card through focus instead: a tap ends with a
              // pointerleave, which would close the card the tap just opened.
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setHovered(point.model.id);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType !== "touch") {
                  setHovered((current) => (current === point.model.id ? null : current));
                }
              }}
              onPointerDown={(event) => event.currentTarget.focus()}
              onFocus={() => setFocused(point.model.id)}
              onBlur={() => setFocused(null)}
            />
          ))}
        </svg>

        {active ? (
          <div
            aria-hidden="true"
            className="bench-hover-card pointer-events-none z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-card border border-stone bg-paper p-2.5 shadow-card sm:block sm:p-3"
            style={
              {
                "--mark-x": `${(active.cx / width) * 100}%`,
                "--mark-y": `${(active.cy / height) * 100}%`,
                "--card-gap": nearTop ? "0.9rem" : "-0.9rem",
                "--card-shift": nearTop ? "0" : "-100%",
              } as CSSProperties
            }
          >
            <p className="flex items-center gap-2 font-mono text-[12px] font-semibold text-charcoal sm:text-[13px]">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: active.colour }}
              />
              {active.name}
            </p>
            {/* Below the small breakpoint the rows join the card's own wrap
                flow, which keeps it to a short band under the plot. */}
            <dl className="contents text-[11px] sm:mt-2 sm:block sm:space-y-1 sm:text-xs">
              {active.metrics.map((metric) => (
                <div key={metric.label} className="flex gap-1.5 sm:justify-between sm:gap-3">
                  <dt className="text-charcoal/60">{metric.label}</dt>
                  <dd className="font-mono text-charcoal">{metric.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
      <figcaption className="mt-2 text-sm text-charcoal/70">
        Gate-verdict correctness against what the run cost, for all{" "}
        {points.length} scored models. Up is better, right is cheaper. The model
        we moved to sits top right: it decides the gate correctly more often
        than anything else measured, for the {winnerCostRank} spend on the
        chart. Point at a mark, or tab to it, for the rest of its row.
      </figcaption>
    </figure>
  );
}
