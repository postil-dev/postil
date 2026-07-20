import { describe, expect, test } from "bun:test";

import {
  deriveGateEnforcementPresentation,
  GATE_ENFORCEMENT_FRESHNESS_MS,
} from "@/lib/gate-enforcement-health";

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("gate enforcement health presentation", () => {
  test("preserves fresh required and not-required evidence", () => {
    expect(
      deriveGateEnforcementPresentation(
        { status: "required", checkedAt: NOW, lastError: null },
        NOW,
      ),
    ).toEqual({ status: "required", stale: false, label: "required" });
    expect(
      deriveGateEnforcementPresentation(
        { status: "not_required", checkedAt: NOW, lastError: null },
        NOW,
      ),
    ).toEqual({ status: "not_required", stale: false, label: "not required" });
  });

  test("does not present stale or absent observations as enforcement", () => {
    const stale = new Date(NOW.getTime() - GATE_ENFORCEMENT_FRESHNESS_MS - 1);
    expect(
      deriveGateEnforcementPresentation(
        { status: "required", checkedAt: stale, lastError: null },
        NOW,
      ),
    ).toEqual({ status: "unknown", stale: true, label: "unknown" });
    expect(
      deriveGateEnforcementPresentation(
        { status: null, checkedAt: null, lastError: null },
        NOW,
      ),
    ).toEqual({ status: "unknown", stale: true, label: "unknown" });
  });
});
