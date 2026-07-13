import { beforeEach, describe, expect, mock, test } from "bun:test";

let lockCalls = 0;
let checkCalls: Array<Record<string, unknown>> = [];
let checkError: Error | null = null;
let effectiveFailing = false;
let storedStates: boolean[] = [];
let tokenWaitForAbort = false;
let transactionsFinalized = 0;

const row = {
  id: 7,
  publicId: "00000000-0000-4000-8000-000000000007",
  repositoryId: 2,
  prNumber: 9,
  headSha: "a".repeat(40),
  status: "completed",
  envelope: { version: 1 },
  engineGateFailing: true,
  gateFailing: true,
  gateCheckRunId: 99,
  repoFullName: "acme/repo",
  orgId: 20,
  githubInstallationId: 42,
};

const selectChain = {
  from() {
    return selectChain;
  },
  innerJoin() {
    return selectChain;
  },
  where() {
    return selectChain;
  },
  limit() {
    return Promise.resolve([row]);
  },
};

const tx = {
  execute: async () => {
    lockCalls += 1;
  },
  select: () => selectChain,
};

mock.module("@/lib/db", () => ({
  getDb: () => ({
    transaction: async (callback: (value: typeof tx) => Promise<void>) => {
      try {
        await callback(tx);
      } finally {
        transactionsFinalized += 1;
      }
    },
  }),
  schema: {
    reviews: {
      id: "reviews.id",
      publicId: "reviews.public_id",
      repositoryId: "reviews.repository_id",
      prNumber: "reviews.pr_number",
      headSha: "reviews.head_sha",
      status: "reviews.status",
      envelope: "reviews.envelope",
      engineGateFailing: "reviews.engine_gate_failing",
      gateFailing: "reviews.gate_failing",
      gateCheckRunId: "reviews.gate_check_run_id",
    },
    repositories: {
      id: "repositories.id",
      installationId: "repositories.installation_id",
      fullName: "repositories.full_name",
    },
    installations: {
      id: "installations.id",
      orgId: "installations.org_id",
      githubInstallationId: "installations.github_installation_id",
    },
  },
}));

mock.module("@/lib/finding-approvals", () => ({
  formatRemainingGateBlockers: () => "- remaining finding",
  getReviewApprovalState: async () => ({
    effectiveGate: { failing: effectiveFailing, blockers: [] },
  }),
  hasNewerCompletedReviewForHead: async () => false,
  lockReviewApprovalState: async () => {
    lockCalls += 1;
  },
  parseEnvelopeForApprovals: () => ({ version: 1 }),
  updateStoredEffectiveGate: async (_db: unknown, _reviewId: number, failing: boolean) => {
    storedStates.push(failing);
  },
}));

mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  getInstallationToken: async (_installationId: number, signal?: AbortSignal) => {
    if (!tokenWaitForAbort) return "installation-token";
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  },
}));

mock.module("@/lib/github/checks", () => ({
  completeCheckRun: async (
    _token: string,
    repoFullName: string,
    checkRunId: number,
    conclusion: string,
  ) => {
    checkCalls.push({ repoFullName, checkRunId, conclusion });
    if (checkError) throw checkError;
  },
  getPullRequestHeadSha: async () => row.headSha,
}));

const { runGateStateSyncJob } = await import("@/worker/gate-state-sync");

beforeEach(() => {
  lockCalls = 0;
  checkCalls = [];
  checkError = null;
  effectiveFailing = false;
  storedStates = [];
  tokenWaitForAbort = false;
  transactionsFinalized = 0;
});

describe("durable gate state synchronization", () => {
  test("recomputes state under an advisory lock before publishing", async () => {
    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(lockCalls).toBe(1);
    expect(storedStates).toEqual([false]);
    expect(checkCalls).toEqual([
      { repoFullName: "acme/repo", checkRunId: 99, conclusion: "success" },
    ]);
  });

  test("an ambiguous delivery retries idempotently from the latest database state", async () => {
    checkError = new Error("connection lost after PATCH");
    await expect(
      runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId }),
    ).rejects.toThrow("connection lost after PATCH");

    checkError = null;
    effectiveFailing = true;
    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(lockCalls).toBe(2);
    expect(storedStates).toEqual([false, true]);
    expect(checkCalls.map((call) => call.conclusion)).toEqual(["success", "failure"]);
  });

  test("rejects malformed internal job payloads", async () => {
    await expect(
      runGateStateSyncJob({ reviewId: 0, reviewPublicId: "bad" }),
    ).rejects.toThrow("gate state sync job payload is malformed");
  });

  test("bounds GitHub calls and releases the transaction for retry", async () => {
    tokenWaitForAbort = true;

    await expect(
      runGateStateSyncJob(
        { reviewId: 7, reviewPublicId: row.publicId },
        { githubTimeoutMs: 5 },
      ),
    ).rejects.toThrow();

    expect(transactionsFinalized).toBe(1);
    expect(lockCalls).toBe(1);
  });
});
