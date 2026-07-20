import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("operator monitoring history", () => {
  test("separates active incidents from retained resolved alerts", () => {
    return readFile(new URL("../src/app/operator/page.tsx", import.meta.url), "utf8")
      .then((source) => {
        expect(source).toContain("Active incidents");
        expect(source).toContain('id="past-monitor-alerts"');
        expect(source).toContain("Past alerts");
        expect(source).toContain("No active incidents.");
        expect(source).toContain("No resolved alerts retained.");
        expect(source).toContain('incident.state === "open"');
        expect(source).toContain('incident.state === "resolved"');
      });
  });
});
