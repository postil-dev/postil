import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildDurationBins,
  ReviewTimeDistribution,
} from "@/components/review-time-distribution";

describe("dashboard metric details", () => {
  test("builds an inclusive five-bin duration distribution", () => {
    const bins = buildDurationBins([1_000, 2_000, 3_000, 4_000, 5_000]);

    expect(bins).toHaveLength(5);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(5);
    expect(bins[0]?.fromMs).toBe(1_000);
    expect(bins.at(-1)?.toMs).toBe(5_000);
  });

  test("renders keyboard-native expandable details with accessible chart data", () => {
    const markup = renderToStaticMarkup(
      <ReviewTimeDistribution durations={[1_000, 2_000, 3_000]} />,
    );

    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain('role="img"');
    expect(markup).toContain("Review-time distribution across 3 reviews");
    expect(markup).toContain("The rust marker is the");
    expect(markup).toContain("33 percent");
  });
});
