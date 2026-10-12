import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("operator monitoring history", () => {
  test("separates active incidents from retained alert history and failed attempts", () => {
    return readFile(new URL("../src/app/operator/page.tsx", import.meta.url), "utf8")
      .then((source) => {
        expect(source).toContain("Active incidents");
        expect(source).toContain('id="past-monitor-alerts"');
        expect(source).toContain("Past alerts");
        expect(source).toContain("No active incidents.");
        expect(source).toContain("No resolved alerts retained.");
        expect(source).toContain('incident.state === "open"');
        // Resolved history reads from the append-only transition log, which
        // retains the evidence captured while the incident was open.
        expect(source).toContain('event.transition === "resolved"');
        expect(source).toContain("{event.detail}");
        expect(source).toContain("incident.openedDetail");
        expect(source).toContain('id="monitor-check-failures"');
        expect(source).toContain("recovered by retry");
        expect(source).toContain("heartbeatDeliveryError");
      });
  });
});
