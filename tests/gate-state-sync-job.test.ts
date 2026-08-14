import { beforeEach, describe, expect, mock, test } from "bun:test";

let lockCalls = 0;
let checkCalls: Array<Record<string, unknown>> = [];
let checkTitles: string[] = [];
let checkSummaries: string[] = [];
let checkError: Error | null = null;
let effectiveFailing = false;
let effectiveUnavailable = false;
let storedStates: boolean[] = [];
let tokenWaitForAbort = false;
let transactionsFinalized = 0;
let gateEnabled = true;
let storedEnforcement: boolean[] = [];
let leaseHeld = false;
let blockToken = false;
let tokenEnteredResolve: (() => void) | null = null;
let tokenReleaseResolve: (() => void) | null = null;
let tokenEntered = Promise.resolve();
let tokenRelease = Promise.resolve();
let loseLeaseAfterCheck = false;
let organizationSettingsHref: string | undefined;

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
  repositoryEnabled: true,
  orgId: 20,
  installationSuspended: false,
  githubInstallationId: 42,
  orgSlug: "acme",
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
  orderBy() {
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

function updateChain() {
  let values: Record<string, unknown> = {};
  const chain = {
    set(next: Record<string, unknown>) {
      values = next;
      return chain;
    },
    where() {
      return chain;
    },
    returning() {
      if ("gateSyncLeaseId" in values) {
        if (leaseHeld) return Promise.resolve([]);
        leaseHeld = true;
      }
      return Promise.resolve(leaseHeld ? [{ id: row.id }] : []);
    },
    then(resolve: (value: unknown) => unknown) {
      if (values.gateSyncLeaseId === null) leaseHeld = false;
      return Promise.resolve([]).then(resolve);
    },
  };
  return chain;
}

mock.module("@/lib/db", () => ({
  getDb: () => ({
    update: () => updateChain(),
    transaction: async <T>(callback: (value: typeof tx) => Promise<T>) => {
      try {
        return await callback(tx);
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
      gateSyncLeaseId: "reviews.gate_sync_lease_id",
      gateSyncLeaseExpiresAt: "reviews.gate_sync_lease_expires_at",
      queuedAt: "reviews.queued_at",
    },
    repositories: {
      id: "repositories.id",
      installationId: "repositories.installation_id",
      fullName: "repositories.full_name",
      enabled: "repositories.enabled",
    },
    installations: {
      id: "installations.id",
      orgId: "installations.org_id",
      githubInstallationId: "installations.github_installation_id",
      suspended: "installations.suspended",
    },
    organizations: {
      id: "organizations.id",
      slug: "organizations.slug",
    },
  },
}));

mock.module("@/lib/oauth", () => ({
  reviewDetailsUrl: (publicId: string, orgSlug: string) =>
    `https://postil.dev/orgs/${orgSlug}/runs/${publicId}`,
  organizationSettingsUrl: () => organizationSettingsHref,
}));

mock.module("@/lib/gate-mode", () => ({
  lockOrganizationGateMode: async () => gateEnabled,
}));

mock.module("@/lib/finding-approvals", () => ({
  formatDismissedGateFindings: () => "Dismissed findings:\n- retained audit",
  formatRemainingGateBlockers: () => "- remaining finding",
  getReviewApprovalState: async () => ({
    effectiveGate: {
      failing: effectiveFailing,
      unavailable: effectiveUnavailable,
      blockers: [],
    },
  }),
  hasNewerCompletedReviewForHead: async () => false,
  lockReviewApprovalState: async () => {
    lockCalls += 1;
  },
  parseEnvelopeForApprovals: () => ({ version: 1 }),
  updateStoredEffectiveGate: async (
    _db: unknown,
    _reviewId: number,
    failing: boolean,
    enforced: boolean,
  ) => {
    storedStates.push(failing);
    storedEnforcement.push(enforced);
  },
}));

mock.module("@/lib/github/app-auth", () => ({
  apiBase: () => "https://api.github.test",
  getInstallationToken: async (_installationId: number, signal?: AbortSignal) => {
    if (blockToken) {
      tokenEnteredResolve?.();
      await tokenRelease;
    }
    if (!tokenWaitForAbort) return "installation-token";
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  },
}));

mock.module("@/lib/github/checks", () => ({
  GATE_CHECK_NAME: "postil/gate",
  checkRunExternalId: (publicId: string, kind: string) =>
    `postil:${publicId}:${kind}`,
  completeExpectedCheckRun: async (
    _token: string,
    repoFullName: string,
    expected: { id: number; conclusion: string; detailsUrl?: string },
    title: string,
    summary: string,
  ) => {
    checkCalls.push({
      repoFullName,
      checkRunId: expected.id,
      conclusion: expected.conclusion,
      detailsUrl: expected.detailsUrl,
    });
    checkTitles.push(title);
    checkSummaries.push(summary);
    if (loseLeaseAfterCheck) leaseHeld = false;
    if (checkError) throw checkError;
  },
  getPullRequestHeadSha: async () => row.headSha,
}));

const { runGateStateSyncJob } = await import("@/worker/gate-state-sync");

beforeEach(() => {
  row.status = "completed";
  lockCalls = 0;
  checkCalls = [];
  checkTitles = [];
  checkSummaries = [];
  checkError = null;
  effectiveFailing = false;
  effectiveUnavailable = false;
  row.status = "completed";
  storedStates = [];
  tokenWaitForAbort = false;
  transactionsFinalized = 0;
  gateEnabled = true;
  storedEnforcement = [];
  leaseHeld = false;
  blockToken = false;
  loseLeaseAfterCheck = false;
  organizationSettingsHref = "https://postil.dev/orgs/acme/settings";
  tokenEntered = new Promise<void>((resolve) => {
    tokenEnteredResolve = resolve;
  });
  tokenRelease = new Promise<void>((resolve) => {
    tokenReleaseResolve = resolve;
  });
});

describe("durable gate state synchronization", () => {
  test("recomputes state under an advisory lock before publishing", async () => {
    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(lockCalls).toBe(2);
    expect(storedStates).toEqual([false]);
    expect(checkCalls).toEqual([
      {
        repoFullName: "acme/repo",
        checkRunId: 99,
        conclusion: "success",
        detailsUrl:
          "https://postil.dev/orgs/acme/runs/00000000-0000-4000-8000-000000000007",
      },
    ]);
    expect(checkSummaries).toEqual([
      "No blocking findings remain for this commit.\n\n" +
        "Dismissed findings:\n- retained audit",
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

    expect(lockCalls).toBe(3);
    expect(storedStates).toEqual([true]);
    expect(checkCalls.map((call) => call.conclusion)).toEqual(["success", "failure"]);
    expect(checkCalls[1]?.detailsUrl).toBe(
      "https://postil.dev/orgs/acme/runs/00000000-0000-4000-8000-000000000007",
    );
  });

  test("rejects malformed internal job payloads", async () => {
    await expect(
      runGateStateSyncJob({ reviewId: 0, reviewPublicId: "bad" }),
    ).rejects.toThrow("gate state sync job payload is malformed");
  });

  test("allows only one publisher for a review at a time", async () => {
    blockToken = true;
    const first = runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });
    await tokenEntered;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });
    tokenReleaseResolve?.();
    await first;

    expect(checkCalls).toHaveLength(1);
    expect(storedStates).toEqual([false]);
    expect(leaseHeld).toBe(false);
  });

  test("stops without retrying after losing the publisher lease", async () => {
    loseLeaseAfterCheck = true;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls).toHaveLength(1);
    expect(storedStates).toEqual([]);
    expect(leaseHeld).toBe(false);
  });

  test("makes an overridden repository blocking request visible in the neutral gate", async () => {
    gateEnabled = false;
    effectiveFailing = true;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("neutral");
    expect(checkTitles).toEqual(["Postil gate blocking overridden"]);
    expect(checkSummaries).toEqual([
      "This repository's effective Postil gate policy requested merge blocking, but merge blocking is disabled for this organization.\n\n" +
        "[Enable merge blocking in organization settings](https://postil.dev/orgs/acme/settings).",
    ]);
    expect(checkCalls[0]?.detailsUrl).toBe(
      "https://postil.dev/orgs/acme/runs/00000000-0000-4000-8000-000000000007",
    );
    expect(storedStates).toEqual([true]);
    expect(storedEnforcement).toEqual([false]);
  });

  test("keeps ordinary advisory output when the repository did not request blocking", async () => {
    gateEnabled = false;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("neutral");
    expect(checkTitles).toEqual(["Postil gate is advisory"]);
    expect(checkSummaries).toEqual([
      "Merge blocking is disabled. Review findings remain advisory.",
    ]);
  });

  test("keeps the failure conclusion and blocker output when merge blocking is enabled", async () => {
    effectiveFailing = true;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("failure");
    expect(checkTitles).toEqual(["Postil gate blocked"]);
    expect(checkSummaries).toEqual(["One or more blocking findings remain.\n\n- remaining finding"]);
  });

  test("keeps unavailable reviews on the existing advisory path when blocking is disabled", async () => {
    gateEnabled = false;
    effectiveFailing = true;
    effectiveUnavailable = true;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("neutral");
    expect(checkTitles).toEqual(["Postil gate is advisory"]);
    expect(checkSummaries).toEqual([
      "Merge blocking is disabled. Review findings remain advisory.",
    ]);
  });

  test("keeps failed reviews on the existing advisory path when blocking is disabled", async () => {
    gateEnabled = false;
    row.status = "failed";

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("neutral");
    expect(checkTitles).toEqual(["Postil gate is advisory"]);
    expect(checkSummaries).toEqual([
      "Merge blocking is disabled. The incomplete review remains advisory.",
    ]);
  });

  test("keeps the override check output bounded when no safe settings URL is available", async () => {
    gateEnabled = false;
    effectiveFailing = true;
    organizationSettingsHref = undefined;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkSummaries).toEqual([
      "This repository's effective Postil gate policy requested merge blocking, but merge blocking is disabled for this organization.\n\n" +
        "Enable merge blocking in the organization settings to enforce this gate.",
    ]);
    expect(checkSummaries[0]!.length).toBeLessThan(2_048);
  });

  test("never describes an operationally unavailable review as passing", async () => {
    effectiveUnavailable = true;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("neutral");
    expect(checkTitles).toEqual(["Review unavailable"]);
    expect(checkCalls[0]?.detailsUrl).toBe(
      "https://postil.dev/orgs/acme/runs/00000000-0000-4000-8000-000000000007",
    );
    expect(storedStates).toEqual([false]);
  });

  test("fails an enforced gate for a terminal no-verdict run", async () => {
    row.status = "failed";

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("failure");
    expect(checkTitles).toEqual(["Review unavailable"]);
    expect(checkSummaries[0]).toContain("merge check remains blocked");
    expect(storedStates).toEqual([true]);
    expect(storedEnforcement).toEqual([true]);
  });

  test("leaves an advisory gate neutral for a terminal no-verdict run", async () => {
    row.status = "failed";
    gateEnabled = false;

    await runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId });

    expect(checkCalls[0]?.conclusion).toBe("neutral");
    expect(checkTitles).toEqual(["Postil gate is advisory"]);
    expect(checkSummaries[0]).toContain("incomplete review remains advisory");
    expect(storedStates).toEqual([true]);
    expect(storedEnforcement).toEqual([false]);
  });

  test("does not write through a stale or mismatched check identity", async () => {
    checkError = new Error(
      "GitHub check-run 99 does not match its review identity",
    );

    await expect(
      runGateStateSyncJob({ reviewId: 7, reviewPublicId: row.publicId }),
    ).rejects.toThrow("does not match its review identity");

    expect(storedStates).toEqual([]);
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
