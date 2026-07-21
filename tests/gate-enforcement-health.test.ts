import { describe, expect, test } from "bun:test";

import {
  buildGateEnforcementDryRunPlan,
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
    ).toEqual({
      status: "required",
      stale: false,
      label: "required",
      enforcementLabel: "enforced",
      consequence: "GitHub requires this App's postil/gate result for merges covered by the rule.",
    });
    expect(
      deriveGateEnforcementPresentation(
        { status: "not_required", checkedAt: NOW, lastError: null },
        NOW,
      ),
    ).toEqual({
      status: "not_required",
      stale: false,
      label: "not required",
      enforcementLabel: "not enforced",
      consequence: "Postil publishes a gate result, but GitHub does not require this App's check before merge.",
    });
  });

  test("does not present stale or absent observations as enforcement", () => {
    const stale = new Date(NOW.getTime() - GATE_ENFORCEMENT_FRESHNESS_MS - 1);
    expect(
      deriveGateEnforcementPresentation(
        { status: "required", checkedAt: stale, lastError: null },
        NOW,
      ),
    ).toEqual({
      status: "unknown",
      stale: true,
      label: "unknown",
      enforcementLabel: "unverified",
      consequence: "Postil publishes a gate result, but merge enforcement could not be verified.",
    });
    expect(
      deriveGateEnforcementPresentation(
        { status: null, checkedAt: null, lastError: null },
        NOW,
      ),
    ).toEqual({
      status: "unknown",
      stale: true,
      label: "unknown",
      enforcementLabel: "unverified",
      consequence: "Postil publishes a gate result, but merge enforcement could not be verified.",
    });
  });

  test("renders a non-mutating setup plan with risk and rollback", () => {
    const presentation = deriveGateEnforcementPresentation(
      { status: "not_required", checkedAt: NOW, lastError: null },
      NOW,
    );
    expect(buildGateEnforcementDryRunPlan(presentation, "main")).toEqual({
      action: "configure",
      target: "Default branch: main",
      desiredRule: "Require postil/gate from the Postil GitHub App. Preserve every other rule.",
      impact: "Merges covered by the rule require this App's postil/gate check to succeed. Configured bypass actors remain exempt.",
      risk: "A Postil outage, configuration error, or failed review blocks merges covered by the rule. Apply per repository and confirm the first protected pull request before wider rollout.",
      rollback: "Remove only the Postil App-bound postil/gate requirement from the same rule. Preserve every other rule.",
    });
  });
});
