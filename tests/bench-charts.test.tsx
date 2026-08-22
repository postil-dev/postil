import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CostAgainstGateChart } from "@/components/bench-charts";
import { SCORED_MODELS } from "@/components/bench-table";

const markup = renderToStaticMarkup(<CostAgainstGateChart />);

const plotted = SCORED_MODELS.filter(
  (model) => model.totalCostUsd !== undefined && model.gateVerdictCorrectness !== undefined,
);

function markCentre(id: string): number {
  const mark = new RegExp(`<circle cx="([0-9.]+)"[^>]*aria-label="${id}\\.`).exec(markup);
  if (!mark) throw new Error(`no interactive mark for ${id}`);
  return Number(mark[1]);
}

function tickCentre(label: string): number {
  const tick = new RegExp(`<text x="([0-9.]+)"[^>]*>\\$${label}</text>`).exec(markup);
  if (!tick) throw new Error(`no cost tick for $${label}`);
  return Number(tick[1]);
}

describe("cost against gate correctness", () => {
  test("runs cost from expensive on the left to cheap on the right", () => {
    expect(tickCentre("1.00")).toBeLessThan(tickCentre("0.50"));
    expect(tickCentre("0.50")).toBeLessThan(tickCentre("0.05"));

    const byCost = [...plotted].sort((first, second) => first.totalCostUsd! - second.totalCostUsd!);
    expect(markCentre(byCost.at(-1)!.id)).toBeLessThan(markCentre(byCost[0]!.id));
  });

  test("says which way the axis runs wherever it is described", () => {
    expect(markup).toContain("cheaper to the right");
    expect(markup).toContain("right is cheaper");
    expect(markup).toContain("sits top right");
    expect(markup).not.toContain("left is cheaper");
    expect(markup).not.toContain("top left");
  });

  test("ranks the selected model's spend as the report ranks it", () => {
    const winner = plotted.find((model) => model.id === "openai/gpt-5.6-luna")!;
    const cheaper = plotted.filter((model) => model.totalCostUsd! < winner.totalCostUsd!).length;
    expect(cheaper).toBe(2);
    expect(markup).toContain("third-lowest spend");
  });

  test("draws no rule across the plot beyond the axis baseline", () => {
    const lines = markup.match(/<line[^>]*>/g) ?? [];
    expect(lines).toHaveLength(1);
    const [y1, y2] = [/y1="([0-9.]+)"/.exec(lines[0]!)![1], /y2="([0-9.]+)"/.exec(lines[0]!)![1]];
    expect(y1).toBe(y2!);
  });

  test("gives every mark a focus stop that names the figures it plots", () => {
    const marks = markup.match(/tabindex="0"/g) ?? [];
    expect(marks).toHaveLength(plotted.length);
    for (const model of plotted) {
      expect(markup).toContain(
        `aria-label="${model.id}. Gate correct ${(model.gateVerdictCorrectness! * 100).toFixed(1)}%.` +
          ` Total cost $${model.totalCostUsd!.toFixed(3)}.` +
          ` Detected ${(model.detectionRate! * 100).toFixed(1)}%.` +
          ` p95 latency ${(model.latencyMsP95! / 1000).toFixed(1)}s."`,
      );
    }
  });

  test("keeps a permanent name clear of every other mark", () => {
    const labelled = ["gpt-5.6-luna", "glm-5.2", "kimi-k2.7-code"];
    const marks = plotted.map((model) => ({
      name: model.id.split("/")[1]!,
      cx: markCentre(model.id),
      cy: Number(
        new RegExp(`<circle cx="[0-9.]+" cy="([0-9.]+)"[^>]*aria-label="${model.id}\\.`).exec(
          markup,
        )![1],
      ),
    }));
    for (const name of labelled) {
      const label = new RegExp(
        `<text x="([0-9.]+)" y="([0-9.]+)" text-anchor="(start|middle|end)"[^>]*>${name}</text>`,
      ).exec(markup);
      expect(label).not.toBeNull();
      const [x, y, anchor] = [Number(label![1]), Number(label![2]), label![3]];
      const span = name.length * 7.3;
      const from = anchor === "start" ? x : anchor === "end" ? x - span : x - span / 2;
      const to = from + span;
      const covered = marks.filter(
        (mark) =>
          mark.name !== name &&
          Math.abs(mark.cy - y) < 8 &&
          mark.cx + 5 > from &&
          mark.cx - 5 < to,
      );
      // A label may reach its own mark and no other.
      expect(covered.map((mark) => mark.name)).toEqual([]);
    }
  });
});
