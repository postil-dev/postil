import type { GateEnforcementStatus } from "./github/gate-enforcement";

export const GATE_ENFORCEMENT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export interface StoredGateEnforcementHealth {
  status: string | null;
  checkedAt: Date | null;
  lastError: string | null;
}

export interface GateEnforcementPresentation {
  status: GateEnforcementStatus;
  stale: boolean;
  label: "required" | "not required" | "unknown";
  enforcementLabel: "enforced" | "not enforced" | "unverified";
  consequence: string;
}

export interface GateEnforcementDryRunPlan {
  action: "none" | "configure" | "inspect";
  target: string;
  desiredRule: string;
  impact: string;
  risk: string;
  rollback: string;
}

export function deriveGateEnforcementPresentation(
  row: StoredGateEnforcementHealth,
  now: Date,
): GateEnforcementPresentation {
  const stale =
    row.checkedAt === null ||
    now.getTime() - row.checkedAt.getTime() > GATE_ENFORCEMENT_FRESHNESS_MS;
  const observed =
    row.status === "required" || row.status === "not_required" || row.status === "unknown"
      ? row.status
      : "unknown";
  const status = stale ? "unknown" : observed;
  return {
    status,
    stale,
    label: status === "required" ? "required" : status === "not_required" ? "not required" : "unknown",
    enforcementLabel: status === "required"
      ? "enforced"
      : status === "not_required"
        ? "not enforced"
        : "unverified",
    consequence: status === "required"
      ? "GitHub blocks merges until the Postil GitHub App's postil/gate check passes."
      : status === "not_required"
        ? "Reviews run, but a failing gate does not block merges here."
        : "Postil cannot read whether this repository's rules enforce the gate.",
  };
}

/** Render an admin-only plan. This function describes a change but never applies one. */
export function buildGateEnforcementDryRunPlan(
  presentation: GateEnforcementPresentation,
  defaultBranch: string | null,
): GateEnforcementDryRunPlan {
  const target = defaultBranch
    ? `Default branch: ${defaultBranch}`
    : "Default branch: verify in GitHub";
  return {
    action: presentation.status === "required"
      ? "none"
      : presentation.status === "not_required"
        ? "configure"
        : "inspect",
    target,
    desiredRule: "Require postil/gate from the Postil GitHub App. Preserve every other rule.",
    impact: "Merges covered by the rule require this App's postil/gate check to succeed. Configured bypass actors remain exempt.",
    risk: "A Postil outage, configuration error, or failed review blocks merges covered by the rule. Apply per repository and confirm the first protected pull request before wider rollout.",
    rollback: "Remove only the Postil App-bound postil/gate requirement from the same rule. Preserve every other rule.",
  };
}
