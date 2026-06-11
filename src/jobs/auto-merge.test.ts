import { describe, expect, it } from "vitest";
import { autoMergeRequiredChecks } from "./auto-merge";

describe("autoMergeRequiredChecks", () => {
  it("uses configured required checks without adding E2E", () => {
    expect(autoMergeRequiredChecks(["Custom CI"], ["E2E tests", "Build"])).toEqual(["Custom CI"]);
  });

  it("uses branch protection check names including renamed E2E jobs", () => {
    expect(autoMergeRequiredChecks([], ["Lint", "End-to-end tests"])).toEqual([
      "Lint",
      "End-to-end tests",
    ]);
  });

  it("does not invent an E2E check when branch protection does not require one", () => {
    expect(autoMergeRequiredChecks([], ["Lint", "Build"])).toEqual(["Lint", "Build"]);
  });

  it("removes the review verifier check from the merge wait set", () => {
    expect(autoMergeRequiredChecks([], ["postil/review", "Verify postil/review passed"])).toEqual([
      "postil/review",
    ]);
  });
});
