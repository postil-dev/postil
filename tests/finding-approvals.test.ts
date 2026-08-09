import { describe, expect, test } from "bun:test";

import type { Database } from "@/lib/db";
import {
  findDismissibleFindingState,
  findKindBlockingState,
  formatRemainingGateBlockers,
  getReviewApprovalState,
  resolveApprovableFindingId,
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
    expect(findKindBlockingState(state, "human-finding")?.findingId).toBe("human-finding");
    expect(findKindBlockingState(state, "risk-finding")).toBeNull();
    expect(findDismissibleFindingState(state, "risk-finding")?.findingId).toBe("risk-finding");
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

  test("partitions dismissals from approvals while preserving dismissed finding status", async () => {
    const dismissal = {
      findingId: "risk-finding",
      verb: "dismiss",
      revokedAt: null,
      createdAt: new Date(),
      id: "dismissal",
      reasonTag: "false-positive",
      authorSelfDismissal: true,
      actorLoginSnapshot: "author",
    } as ApprovalRow;
    const state = await getReviewApprovalState(approvalDb([dismissal]), review);

    expect(state.findingStates.map((entry) => entry.findingId)).toEqual(["human-finding"]);
    expect(state.dismissalFindingStates.find((entry) => entry.findingId === "risk-finding"))
      .toMatchObject({ activeApproval: null, activeDismissal: dismissal, blocking: false });
    expect(state.effectiveGate.failing).toBe(true);
    expect(formatRemainingGateBlockers(state.effectiveGate, state.dismissalFindingStates))
      .toContain("Dismissed by @author: false-positive; pull request author");
  });

  test("a passing gate summary retains the dismissal audit", async () => {
    const dismissal = {
      findingId: "risk-finding",
      verb: "dismiss",
      revokedAt: null,
      createdAt: new Date(),
      id: "dismissal",
      reasonTag: "accepted-risk",
      authorSelfDismissal: false,
      actorLoginSnapshot: "maintainer",
    } as ApprovalRow;
    const riskOnlyReview: ReviewForApproval = {
      ...review,
      envelope: {
        ...envelope,
        findings: [envelope.findings[1]!],
        counts: { ...envelope.counts, warn: 1 },
        confidenceBuckets: [0, 0, 0, 0, 1],
      },
    };
    const state = await getReviewApprovalState(approvalDb([dismissal]), riskOnlyReview);

    expect(state.effectiveGate.failing).toBe(false);
    expect(formatRemainingGateBlockers(state.effectiveGate, state.dismissalFindingStates))
      .toBe(
        "No blocking findings remain.\n\nDismissed findings:\n" +
          "- Fix the risk risk-finding (Dismissed by @maintainer: accepted-risk)",
      );
  });

  test("a revoked dismissal leaves the finding eligible for re-issue", async () => {
    const revoked = {
      findingId: "risk-finding",
      verb: "dismiss",
      revokedAt: new Date(),
      createdAt: new Date(),
      id: "revoked-dismissal",
    } as ApprovalRow;
    const state = await getReviewApprovalState(approvalDb([revoked]), review);
    expect(state.dismissalFindingStates.find((entry) => entry.findingId === "risk-finding"))
      .toMatchObject({ activeDismissal: null, latestDismissal: revoked, dismissible: true });
  });
});

const hexIdA = "a1b2c3d4e5f6".padEnd(64, "0");
const hexIdB = "a1b2c3d4e5f6".padEnd(64, "1");
const hexIdDistinct = "ffee00112233".padEnd(64, "2");

function hexFinding(id: string, title: string): Envelope["findings"][number] {
  return {
    id,
    path: "src/policy.ts",
    line: 10,
    severity: "warn",
    kind: "humanEscalation",
    confidence: 0.9,
    title,
    body: "Confirm the accountable owner accepts this change.",
  };
}

const hexEnvelope: Envelope = {
  ...envelope,
  findings: [
    hexFinding(hexIdA, "Shared prefix A"),
    hexFinding(hexIdB, "Shared prefix B"),
    hexFinding(hexIdDistinct, "Distinct finding"),
  ],
  counts: { info: 0, warn: 3, error: 0, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: [0, 0, 0, 0, 3],
};

describe("finding id prefix resolution", () => {
  async function hexState() {
    return getReviewApprovalState(approvalDb([]), { ...review, envelope: hexEnvelope });
  }

  test("resolves a full id and an unambiguous prefix", async () => {
    const state = await hexState();

    expect(resolveApprovableFindingId(state, hexIdDistinct)).toEqual({
      ok: true,
      findingId: hexIdDistinct,
    });
    // The 12-character truncated form shown in gate summaries.
    expect(resolveApprovableFindingId(state, "ffee00112233")).toEqual({
      ok: true,
      findingId: hexIdDistinct,
    });
    expect(resolveApprovableFindingId(state, hexIdA.slice(0, 20))).toEqual({
      ok: true,
      findingId: hexIdA,
    });
  });

  test("rejects ambiguous, too-short, and unknown prefixes", async () => {
    const state = await hexState();

    expect(resolveApprovableFindingId(state, "a1b2c3d4e5f6")).toEqual({
      ok: false,
      reason: "ambiguous",
      matches: [hexIdA, hexIdB],
    });
    expect(resolveApprovableFindingId(state, "ffee001")).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(resolveApprovableFindingId(state, "0000000000000000")).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("gate summaries keep colliding truncated ids usable as full ids", async () => {
    const state = await hexState();
    const summary = formatRemainingGateBlockers(state.effectiveGate);

    expect(summary).toContain(` ${hexIdA} `);
    expect(summary).toContain(` ${hexIdB} `);
    expect(summary).toContain(" ffee00112233 ");
    expect(summary).not.toContain(hexIdDistinct);
  });
});
