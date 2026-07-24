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
      ? "GitHub requires this App's postil/gate result for merges covered by the rule."
      : status === "not_required"
        ? "Postil publishes a gate result, but GitHub does not require this App's check before merge."
        : "Postil publishes a gate result, but merge enforcement could not be verified.",
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

/**
 * A self-contained work order a repository admin can paste into a coding
 * agent. It only describes the change this page's dry-run plan proposes; the
 * agent acting on it needs the admin's own GitHub credentials.
 */
export function buildGateEnforcementAgentPrompt(input: {
  repoFullName: string;
  defaultBranch: string | null;
  appId: number | null;
}): string {
  const branch = input.defaultBranch ?? "the default branch";
  const identity = input.appId === null
    ? 'the Postil GitHub App (find its id with `gh api "repos/{owner}/{repo}/installation" --jq .app_id` using the repository owner credentials)'
    : `the Postil GitHub App (app id ${input.appId})`;
  return [
    `Configure GitHub merge enforcement for the repository ${input.repoFullName}.`,
    "",
    `Goal: GitHub must require the \`postil/gate\` status check from ${identity} on ${branch}. Preserve every existing rule, required check, and bypass actor exactly as it is.`,
    "",
    "Steps:",
    `1. Read the current state with the GitHub CLI as a repository admin:`,
    `   - gh api repos/${input.repoFullName}/rulesets`,
    `   - gh api "repos/${input.repoFullName}/rules/branches/${input.defaultBranch ?? "<default-branch>"}"`,
    `   - gh api repos/${input.repoFullName}/branches/${input.defaultBranch ?? "<default-branch>"}/protection (a 404 means no classic protection; that is fine)`,
    `2. Prefer a ruleset. If an active ruleset already targets ${branch} with a required_status_checks rule, add {"context": "postil/gate", "integration_id": ${input.appId ?? "<postil-app-id>"}} to its required checks. Otherwise create a new active ruleset targeting the default branch with only that required status check. Do not modify classic branch protection unless it already requires postil/gate without the App binding, in which case bind the existing entry to the App instead.`,
    "3. Change nothing else: no other rules, checks, bypass actors, or protection settings.",
    `4. Verify: re-run gh api "repos/${input.repoFullName}/rules/branches/${input.defaultBranch ?? "<default-branch>"}" and confirm a required_status_checks entry with context postil/gate and integration_id ${input.appId ?? "<postil-app-id>"} is present.`,
    "5. Report the exact API calls made and the verification output.",
    "",
    "Rollback, if ever needed: remove only the postil/gate requirement added here and nothing else.",
  ].join("\n");
}
