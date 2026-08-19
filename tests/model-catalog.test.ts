import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import benchResults from "@/data/bench-results.json";
import { MODEL_CATALOG_CAPTURE_DATE, MODELS } from "@/data/models";
import sitemap from "@/app/sitemap";

describe("model catalog evidence", () => {
  test("marks only checked-in bench models as tested", () => {
    // The bench scores models the catalogue does not carry, so this is a
    // subset rather than an equality: a `tested` badge must be backed by a
    // scored run, but a scored run need not earn a catalogue row.
    const benchIds = new Set(benchResults.models.map((model) => model.id));
    const untestedClaims = MODELS.filter(
      (model) => model.tested && !benchIds.has(model.id),
    ).map((model) => model.id);
    expect(untestedClaims).toEqual([]);
  });

  test("prices every catalogue model in both directions", () => {
    // `calculateUsageCostMicrosForModel` reads these prices to fill
    // `usage_events.cost_micros`, and returns null for an id it cannot find.
    // A zero or missing price records no spend instead of failing loudly.
    const unpriced = MODELS.filter(
      (model) => !(model.pricePerToken.input > 0) || !(model.pricePerToken.output > 0),
    ).map((model) => model.id);
    expect(unpriced).toEqual([]);
  });

  test("prices the model the bench page tells readers to run", () => {
    const source = readFileSync("src/app/bench/page.tsx", "utf8");
    const match = /REVIEW_MODEL=(\S+)/u.exec(source);
    expect(match).not.toBeNull();
    expect(MODELS.some((model) => model.id === match![1]!)).toBe(true);
  });

  test("uses a bench-backed model in the live-bench example", () => {
    const source = readFileSync("src/app/docs/models/page.tsx", "utf8");
    // Anchored on the bench invocation itself: the local-inference examples
    // above it also set REVIEW_MODEL, and those name served models that this
    // bench table has no reason to score.
    const match = /REVIEW_MODEL=(\S+)[\s\\]+bun run bench:live/u.exec(source);
    expect(match).not.toBeNull();
    const benchIds = new Set(benchResults.models.map((model) => model.id));
    expect(benchIds.has(match![1]!)).toBe(true);
  });

  test("names the fixture corpus the published figures were scored against", () => {
    // Two published tables are comparable only when they scored the same
    // fixtures, so the digest travels with the numbers rather than the prose.
    expect(benchResults.fixtureCorpusSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("binds the models sitemap date to the catalog snapshot", () => {
    expect(MODEL_CATALOG_CAPTURE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const modelsRoute = sitemap().find((entry) => entry.url.endsWith("/docs/models"));
    expect(modelsRoute?.lastModified).toEqual(new Date(`${MODEL_CATALOG_CAPTURE_DATE}T00:00:00Z`));
  });
});
