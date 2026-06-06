import { describe, expect, it } from "vitest";
import { safeReportsCallbackPath } from "./login-callback";

describe("safeReportsCallbackPath", () => {
  it("allows only report paths", () => {
    expect(safeReportsCallbackPath("/reports")).toBe("/reports");
    expect(safeReportsCallbackPath("/reports/123?tab=result")).toBe("/reports/123?tab=result");
  });

  it("falls back for external or unrelated paths", () => {
    expect(safeReportsCallbackPath("https://example.com/reports")).toBe("/reports");
    expect(safeReportsCallbackPath("/settings")).toBe("/reports");
    expect(safeReportsCallbackPath("//example.com")).toBe("/reports");
    expect(safeReportsCallbackPath("/reports/%2f%2fevil.test")).toBe("/reports");
    expect(safeReportsCallbackPath("/reports\\evil")).toBe("/reports");
  });
});
