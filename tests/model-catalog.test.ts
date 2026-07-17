import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import benchResults from "@/data/bench-results.json";
import { MODEL_CATALOG_CAPTURE_DATE, MODELS } from "@/data/models";
import sitemap from "@/app/sitemap";

describe("model catalog evidence", () => {
  test("marks only checked-in bench models as tested", () => {
    const benchIds = new Set(benchResults.models.map((model) => model.id));
    expect(MODELS.filter((model) => model.tested).map((model) => model.id).sort()).toEqual(
      [...benchIds].sort(),
    );
  });

  test("uses bench-backed models in the live-bench example", () => {
    const source = readFileSync("src/app/docs/models/page.tsx", "utf8");
    const match = /POSTIL_BENCH_MODELS=([^\n]+)/u.exec(source);
    expect(match).not.toBeNull();
    const exampleIds = match![1]!.split(",");
    const benchIds = new Set(benchResults.models.map((model) => model.id));
    expect(exampleIds.length).toBeGreaterThan(0);
    for (const id of exampleIds) expect(benchIds.has(id)).toBe(true);
  });

  test("binds the models sitemap date to the catalog snapshot", () => {
    expect(MODEL_CATALOG_CAPTURE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const modelsRoute = sitemap().find((entry) => entry.url.endsWith("/docs/models"));
    expect(modelsRoute?.lastModified).toEqual(new Date(`${MODEL_CATALOG_CAPTURE_DATE}T00:00:00Z`));
  });
});
