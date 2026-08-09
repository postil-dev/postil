import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("describes the ungrounded denominator without calling it all candidates", () => {
    const source = readFileSync("src/app/orgs/[slug]/page.tsx", "utf8");
    expect(source).toContain("Policy-suppressed findings are excluded.");
    expect(source).toContain("dropped · {shipped} reached pull requests");
    expect(source).not.toContain("candidate findings dropped");
  });

  test("labels confidence as percentages and does not draw empty buckets", () => {
    const source = readFileSync("src/app/orgs/[slug]/page.tsx", "utf8");

    expect(source).toContain('"0–20%", "20–40%", "40–60%", "60–80%", "80–100%"');
    expect(source).toContain("share of shipped findings on a linear scale");
    expect(source).toContain("v > 0");
    expect(source).toContain(': "0"');
    expect(source).not.toContain('"0–.2"');
  });

  test("does not present silence rate as a commit-quality score", () => {
    const source = readFileSync("src/app/orgs/[slug]/page.tsx", "utf8");
    expect(source).toContain("reviewer output frequency, not commit quality");
    expect(source).toContain("Review yield");
  });

  test("keeps suppressed details and admin overrides behind native disclosure controls", () => {
    const source = readFileSync("src/app/orgs/[slug]/runs/[publicId]/page.tsx", "utf8");
    expect(source).toContain("Suppressed findings ({envelope.counts.suppressed})");
    expect(source).toContain("This review predates retained suppression details");
    expect(source).toContain("Record a commit-scoped override");
  });

  test("exposes dismissal and revocation actions with their visible state", () => {
    const source = readFileSync("src/app/orgs/[slug]/runs/[publicId]/page.tsx", "utf8");
    const form = readFileSync(
      "src/app/orgs/[slug]/runs/[publicId]/dismiss-finding-form.tsx",
      "utf8",
    );
    const revokeForm = readFileSync(
      "src/app/orgs/[slug]/runs/[publicId]/revoke-dismissal-form.tsx",
      "utf8",
    );
    expect(source).toContain("<DismissFindingForm");
    expect(form).toContain("dismissFindingWithState");
    expect(source).toContain("<RevokeDismissalForm");
    expect(revokeForm).toContain("revokeFindingDismissalWithState");
    expect(source).toContain('"Dismissed"');
    expect(source).toContain("Pull request author dismissed this finding");
    expect(source).toContain("@postil dismiss {state.findingId} -- false-positive: rationale");
  });

  test("keeps dashboard and run metadata above the AA contrast floor", () => {
    const sources = [
      "src/app/orgs/[slug]/page.tsx",
      "src/app/orgs/[slug]/reviews-table.tsx",
      "src/app/orgs/[slug]/runs/[publicId]/live-run.tsx",
      "src/app/orgs/[slug]/runs/[publicId]/page.tsx",
      "src/components/finding-confidence.tsx",
      "src/components/review-time-distribution.tsx",
    ].map((path) => readFileSync(path, "utf8"));

    for (const source of sources) {
      expect(source).not.toMatch(
        /(?<!placeholder:)text-charcoal\/(?:[1-6][0-9]|[1-9])(?!\d)/,
      );
      expect(source).not.toMatch(/\bopacity-(?:[1-9]|[1-6][0-9])\b/);
    }
  });
});
