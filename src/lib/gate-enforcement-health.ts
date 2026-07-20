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
  };
}
