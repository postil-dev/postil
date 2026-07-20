import { describe, expect, test } from "bun:test";

import type { Database } from "@/lib/db";
import {
  getReviewApprovalState,
  type ApprovalRow,
  type ReviewForApproval,
} from "@/lib/finding-approvals";
import type { Envelope } from "@/lib/envelope";

function approvalDb(rows: ApprovalRow[]): Database {
  const chain = {
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return Promise.resolve(rows);
    },
  };
  return { select: () => chain } as unknown as Database;
}

const envelope: Envelope = {
  version: 1,
  summary: "Human decision and risk.",
  silent: false,
  findings: [
    {
      id: "human-finding",
      path: "src/policy.ts",
      line: 10,
      severity: "warn",
      kind: "humanEscalation",
      confidence: 0.9,
      title: "Confirm policy",
      body: "Confirm the accountable owner accepts this change.",
    },
    {
      id: "risk-finding",
      path: "src/risk.ts",
      line: 20,
      severity: "warn",
      kind: "risk",
      confidence: 0.9,
      title: "Fix the risk",
      body: "Fix the concrete defect.",
    },
  ],
  resolved: [],
  counts: { info: 0, warn: 2, error: 0, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: [0, 0, 0, 0, 2],
  gate: {
    failOn: "error",
    failing: true,
    blockOnKinds: ["humanEscalation", "risk"],
  },
  modelUsed: "example/model",
  usage: { promptTokens: 10, completionTokens: 10 },
  durationMs: 10,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  sinceSha: null,
};

const review: ReviewForApproval = {
  id: 7,
  publicId: "00000000-0000-4000-8000-000000000007",
  repositoryId: 2,
  prNumber: 9,
  headSha: "b".repeat(40),
  status: "completed",
  envelope,
  engineGateFailing: true,
  gateFailing: true,
  gateCheckRunId: 99,
  repoFullName: "acme/repo",
  orgId: 20,
  githubInstallationId: 42,
  githubRepoId: 21,
  installationAccountType: "Organization",
};

describe("finding approval scope", () => {
  test("offers approval only for calibrated human escalation findings", async () => {
    const state = await getReviewApprovalState(approvalDb([]), review);

    expect(state.findingStates.map((entry) => entry.findingId)).toEqual([
      "human-finding",
    ]);
    expect(state.effectiveGate.failing).toBe(true);
  });

  test("ignores legacy approvals for non-human kind blockers", async () => {
    const activeRiskApproval = {
      findingId: "risk-finding",
      revokedAt: null,
      createdAt: new Date(),
      id: "approval",
    } as ApprovalRow;
    const state = await getReviewApprovalState(
      approvalDb([activeRiskApproval]),
      review,
    );

    expect(state.effectiveGate.failing).toBe(true);
    expect(state.effectiveGate.blockers.some((entry) => entry.finding.id === "risk-finding")).toBe(
      true,
    );
  });
});
