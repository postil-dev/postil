import { describe, expect, it } from "vitest";
import { classifyReviewFailure, findingCounts } from "./review-metrics";

describe("review metrics helpers", () => {
  it("classifies failures into dashboard-safe buckets", () => {
    expect(classifyReviewFailure(Object.assign(new Error("timeout"), { timedOut: true }))).toBe("timeout");
    expect(classifyReviewFailure(Object.assign(new Error("missing"), { code: "CLI_NOT_FOUND" }))).toBe("config");
    expect(classifyReviewFailure(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe("auth");
    expect(classifyReviewFailure(new Error("Trigger API token must be set"))).toBe("trigger");
    expect(classifyReviewFailure(new Error("review JSON parse failed"))).toBe("parser");
    expect(classifyReviewFailure(new Error("GitHub API rate limit"))).toBe("github_api");
  });

  it("counts finding severities without storing finding bodies", () => {
    expect(
      findingCounts([
        { path: "a.ts", line: 1, severity: "error", body: "x" },
        { path: "b.ts", line: 2, severity: "warn", body: "y" },
        { path: "c.ts", line: 3, severity: "info", body: "z" },
      ]),
    ).toEqual({
      findingCount: 3,
      errorFindingCount: 1,
      warnFindingCount: 1,
      infoFindingCount: 1,
    });
  });
});
