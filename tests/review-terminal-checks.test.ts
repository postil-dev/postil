import { beforeEach, describe, expect, mock, test } from "bun:test";

const realDb = await import("@/lib/db");
const realChecks = await import("@/lib/github/checks");
const realAppAuth = await import("@/lib/github/app-auth");

const activeReviews = [{
  id: 10,
  publicId: "00000000-0000-0000-0000-000000000010",
  status: "running",
  headSha: "old-head-sha",
  advisoryCheckRunId: 11,
  gateCheckRunId: 22,
}];
const transitions: Array<Record<string, unknown>> = [];
let cleanupIntents = 0;
const completions: Array<{
  id: number;
  conclusion: string;
  title: string;
  summary: string;
  detailsUrl?: string;
}> = [];
const failingCompletionIds = new Set<number>();
let reconciledCheckRunId: number | null = null;
const verifiedCompletionIds: number[] = [];
let organizationGateEnabled = true;

function exactChecks(
  detailsUrl?: string,
  publicationIncomplete = false,
) {
  return {
    advisory: {
      id: 11,
      name: "postil/review",
      externalId: "postil:run-id:review",
      headSha: "head-sha",
      ...(detailsUrl ? { detailsUrl } : {}),
    },
    gate: {
      id: 22,
      name: "postil/gate",
      externalId: "postil:run-id:gate",
      headSha: "head-sha",
      ...(detailsUrl ? { detailsUrl } : {}),
    },
    publicationIncomplete,
  };
}

function fakeDb(): any {
  const db = {
    transaction<T>(callback: (tx: ReturnType<typeof fakeDb>) => Promise<T>) {
      return callback(fakeDb());
    },
    select() {
      const chain = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        for() {
          return chain;
        },
        limit() {
          return Promise.resolve(activeReviews);
        },
        then<TResult1 = typeof activeReviews, TResult2 = never>(
          onfulfilled?: ((value: typeof activeReviews) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(activeReviews).then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
    update() {
      const chain = {
        set(values: Record<string, unknown>) {
          transitions.push(values);
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve([{ id: 10 }]);
        },
      };
      return chain;
    },
    execute() {
      cleanupIntents += 1;
      return Promise.resolve({ rows: [] });
    },
  };
  return db;
}

mock.module("@/lib/db", () => ({
  ...realDb,
  getDb: () => fakeDb(),
}));

mock.module("@/lib/github/app-auth", () => ({
  ...realAppAuth,
  getInstallationToken: async () => "test-token",
}));

mock.module("@/lib/github/checks", () => ({
  ...realChecks,
  findCheckRunByExternalId: async () => reconciledCheckRunId,
  completeCheckRun: async (
    _token: string,
    _repo: string,
    id: number,
    conclusion: string,
    title: string,
    summary: string,
    _signal?: AbortSignal,
    detailsUrl?: string,
  ) => {
    if (failingCompletionIds.has(id))
      throw new Error(`check-run ${id} unavailable`);
    completions.push({
      id,
      conclusion,
      title,
      summary,
      ...(detailsUrl ? { detailsUrl } : {}),
    });
  },
  completeExpectedCheckRun: async (
    _token: string,
    _repo: string,
    expected: { id: number; conclusion: string; detailsUrl?: string },
    title: string,
    summary: string,
  ) => {
    if (failingCompletionIds.has(expected.id))
      throw new Error(`check-run ${expected.id} unavailable`);
    verifiedCompletionIds.push(expected.id);
    completions.push({
      id: expected.id,
      conclusion: expected.conclusion,
      title,
      summary,
      ...(expected.detailsUrl ? { detailsUrl: expected.detailsUrl } : {}),
    });
  },
}));

mock.module("@/lib/gate-mode", () => ({
  getInstallationGateEnabled: async () => organizationGateEnabled,
  getOrganizationGateEnabled: async () => organizationGateEnabled,
  lockOrganizationGateMode: async () => organizationGateEnabled,
}));

const {
  completeHostedInferenceDisabledCheckRuns,
  failCheckRuns,
  runCheckRunCleanupJob,
  supersedeActiveReviews,
  validateCheckRunCleanupPayload,
} = await import("@/worker/review");

beforeEach(() => {
  transitions.length = 0;
  cleanupIntents = 0;
  completions.length = 0;
  failingCompletionIds.clear();
  reconciledCheckRunId = null;
  verifiedCompletionIds.length = 0;
  organizationGateEnabled = true;
});

describe("review terminal check-runs", () => {
  test("requires immutable identity evidence for ambiguous cleanup", () => {
    expect(() =>
      validateCheckRunCleanupPayload({
        installationId: 42,
        repoFullName: "postil-dev/postil",
        advisoryCheckRunId: null,
        gateCheckRunId: null,
        advisoryCheckRunMayExist: true,
        message: "GitHub check-run creation was ambiguous",
      }),
    ).toThrow("check-run cleanup job payload is malformed");
  });

  test("requires immutable identity evidence for known check ids", () => {
    expect(() =>
      validateCheckRunCleanupPayload({
        installationId: 42,
        repoFullName: "postil-dev/postil",
        advisoryCheckRunId: 11,
        gateCheckRunId: 22,
        message: "worker stopped",
      }),
    ).toThrow("check-run cleanup job payload is malformed");
  });

  test("disabled hosted inference leaves both checks neutral without provider detail", async () => {
    await completeHostedInferenceDisabledCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      false,
      undefined,
      exactChecks(),
    );

    expect(completions).toEqual([
      {
        id: 11,
        conclusion: "neutral",
        title: "Review unavailable",
        summary:
          "Postil did not run a review for this commit. No review comment or verdict was published.",
      },
      {
        id: 22,
        conclusion: "neutral",
        title: "Review unavailable",
        summary:
          "Postil did not run a review for this commit. No review comment or verdict was published.",
      },
    ]);
    expect(JSON.stringify(completions)).not.toMatch(/provider|model/i);
  });

  test("disabled hosted inference attempts both neutral completions without throwing", async () => {
    failingCompletionIds.add(11);

    await expect(
      completeHostedInferenceDisabledCheckRuns(
        "test-token",
        "postil-dev/postil",
        11,
        22,
        false,
        undefined,
        exactChecks(),
      ),
    ).resolves.toBe(false);

    expect(completions).toEqual([
      {
        id: 22,
        conclusion: "neutral",
        title: "Review unavailable",
        summary:
          "Postil did not run a review for this commit. No review comment or verdict was published.",
      },
    ]);
  });

  test("neutral cleanup fails closed so the queue retries unresolved checks", async () => {
    failingCompletionIds.add(11);

    await expect(
      completeHostedInferenceDisabledCheckRuns(
        "test-token",
        "postil-dev/postil",
        11,
        22,
        true,
        undefined,
        exactChecks(),
      ),
    ).rejects.toThrow("could not neutralize unavailable review check-runs");
    expect(
      completions.map(({ id, conclusion }) => ({ id, conclusion })),
    ).toEqual([{ id: 22, conclusion: "neutral" }]);
  });

  test("superseded reviews neutralize both checks with the replacement head", async () => {
    const count = await supersedeActiveReviews({
      repositoryId: 5,
      prNumber: 313,
      newHeadSha: "new-head-sha",
      repoFullName: "postil-dev/postil",
      githubInstallationId: 42,
    });

    expect(count).toBe(1);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).toBe("stale");
    expect(cleanupIntents).toBe(1);
    expect(completions).toEqual([]);
  });

  test("execution failure is neutral on review and fails the enforced gate", async () => {
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "worker stopped",
      undefined,
      false,
      undefined,
      exactChecks(),
    );

    expect(
      completions.map(({ id, conclusion }) => ({ id, conclusion })),
    ).toEqual([
      { id: 22, conclusion: "failure" },
      { id: 11, conclusion: "neutral" },
    ]);
    expect(
      completions.every(({ summary }) => !summary.includes("worker stopped")),
    ).toBe(true);
    expect(completions[0]?.summary).toContain("no review verdict exists");
    expect(completions[1]?.title).toBe("Review did not complete");
  });

  test("public failure output links the private run without exposing provider detail", async () => {
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "provider secret detail",
      undefined,
      false,
      "https://postil.dev/orgs/postil-dev/runs/run-id",
      exactChecks("https://postil.dev/orgs/postil-dev/runs/run-id"),
    );

    expect(
      completions.every(
        ({ summary }) => !summary.includes("provider secret detail"),
      ),
    ).toBe(true);
    expect(completions[0]?.summary).toContain(
      "[Review details](https://postil.dev/orgs/postil-dev/runs/run-id)",
    );
    expect(completions.map(({ detailsUrl }) => detailsUrl)).toEqual([
      "https://postil.dev/orgs/postil-dev/runs/run-id",
      "https://postil.dev/orgs/postil-dev/runs/run-id",
    ]);
  });

  test("publication cleanup verifies exact identities and names the publication failure", async () => {
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "check-run 22 is not completed",
      undefined,
      true,
      "https://postil.dev/orgs/postil-dev/runs/run-id",
      {
        advisory: {
          id: 11,
          name: "postil/review",
          externalId: "postil:run-id:review",
          headSha: "head-sha",
        },
        gate: {
          id: 22,
          name: "postil/gate",
          externalId: "postil:run-id:gate",
          headSha: "head-sha",
        },
        publicationIncomplete: true,
      },
    );

    expect(verifiedCompletionIds).toEqual([22, 11]);
    expect(completions.map(({ title }) => title)).toEqual([
      "Review publication incomplete",
      "Review publication incomplete",
    ]);
    expect(completions[0]?.summary).toContain(
      "GitHub did not receive the complete result",
    );
    expect(completions[0]?.summary).toContain(
      "[Review details](https://postil.dev/orgs/postil-dev/runs/run-id)",
    );
  });

  test("publication cleanup rejects incomplete identity evidence", async () => {
    await expect(
      failCheckRuns(
        "test-token",
        "postil-dev/postil",
        11,
        22,
        "publication failed",
        undefined,
        true,
        undefined,
        { publicationIncomplete: true },
      ),
    ).rejects.toThrow("requires the exact GitHub check-run identities");
    expect(completions).toEqual([]);
  });

  test("strict cleanup rejects when a check-run remains incomplete", async () => {
    failingCompletionIds.add(22);

    await expect(
      failCheckRuns(
        "test-token",
        "postil-dev/postil",
        11,
        22,
        "watchdog deadline",
        undefined,
        true,
        undefined,
        exactChecks(),
      ),
    ).rejects.toThrow("could not complete failed review check-runs");
    expect(completions.map(({ id }) => id)).toEqual([11]);
  });

  test("failure cleanup is idempotent for already terminal check-runs", async () => {
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "publication failed",
      undefined,
      false,
      undefined,
      exactChecks(),
    );
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "publication failed",
      undefined,
      false,
      undefined,
      exactChecks(),
    );

    expect(
      completions.map(({ id, conclusion }) => ({ id, conclusion })),
    ).toEqual([
      { id: 22, conclusion: "failure" },
      { id: 11, conclusion: "neutral" },
      { id: 22, conclusion: "failure" },
      { id: 11, conclusion: "neutral" },
    ]);
  });

  test("operational failure leaves an advisory gate neutral", async () => {
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "publication failed",
      undefined,
      false,
      "https://postil.dev/orgs/postil-dev/runs/run-id",
      exactChecks("https://postil.dev/orgs/postil-dev/runs/run-id"),
      false,
    );

    expect(completions.map(({ id, conclusion, title }) => ({ id, conclusion, title })))
      .toEqual([
        { id: 22, conclusion: "neutral", title: "Postil gate is advisory" },
        { id: 11, conclusion: "neutral", title: "Review did not complete" },
      ]);
    expect(completions.map(({ detailsUrl }) => detailsUrl)).toEqual([
      "https://postil.dev/orgs/postil-dev/runs/run-id",
      "https://postil.dev/orgs/postil-dev/runs/run-id",
    ]);
  });

  test("durable watchdog cleanup resolves advisory mode at execution time", async () => {
    organizationGateEnabled = false;
    await runCheckRunCleanupJob({
      installationId: 42,
      repoFullName: "postil-dev/postil",
      advisoryCheckRunId: 11,
      gateCheckRunId: 22,
      headSha: "head-sha",
      advisoryCheckExternalId: "postil:run-id:review",
      gateCheckExternalId: "postil:run-id:gate",
      message: "worker stopped",
    });

    expect(completions.map(({ id, conclusion, title }) => ({ id, conclusion, title })))
      .toEqual([
        { id: 22, conclusion: "neutral", title: "Postil gate is advisory" },
        { id: 11, conclusion: "neutral", title: "Review did not complete" },
      ]);
  });

  test("durable unavailable cleanup verifies exact identities", async () => {
    await runCheckRunCleanupJob({
      installationId: 42,
      repoFullName: "postil-dev/postil",
      advisoryCheckRunId: 11,
      gateCheckRunId: 22,
      headSha: "head-sha",
      advisoryCheckExternalId: "postil:run-id:review",
      gateCheckExternalId: "postil:run-id:gate",
      message: "hosted review unavailable",
      intent: "neutralize",
    });

    expect(verifiedCompletionIds).toEqual([11, 22]);
    expect(completions.map(({ id, conclusion, title }) => ({
      id,
      conclusion,
      title,
    }))).toEqual([
      { id: 11, conclusion: "neutral", title: "Review unavailable" },
      { id: 22, conclusion: "neutral", title: "Review unavailable" },
    ]);
  });

  test("queued publication cleanup keeps the exact run identity", async () => {
    await runCheckRunCleanupJob({
      installationId: 42,
      repoFullName: "postil-dev/postil",
      advisoryCheckRunId: 11,
      gateCheckRunId: 22,
      headSha: "head-sha",
      advisoryCheckExternalId: "postil:run-id:review",
      gateCheckExternalId: "postil:run-id:gate",
      message: "publication verification failed",
      detailsUrl: "https://postil.dev/orgs/postil-dev/runs/run-id",
      intent: "fail",
      publicationIncomplete: true,
    });

    expect(verifiedCompletionIds).toEqual([22, 11]);
    expect(completions.every(({ title }) =>
      title === "Review publication incomplete"
    )).toBe(true);
    expect(completions.map(({ detailsUrl }) => detailsUrl)).toEqual([
      "https://postil.dev/orgs/postil-dev/runs/run-id",
      "https://postil.dev/orgs/postil-dev/runs/run-id",
    ]);
  });

  test("cleanup completes known checks before retrying an unresolved ambiguous peer", async () => {
    await expect(
      runCheckRunCleanupJob({
        installationId: 42,
        repoFullName: "postil-dev/postil",
        advisoryCheckRunId: 11,
        gateCheckRunId: null,
        headSha: "head-sha",
        advisoryCheckExternalId: "postil:run-id:review",
        gateCheckExternalId: "postil:run:gate",
        gateCheckRunMayExist: true,
        message: "worker stopped",
      }),
    ).rejects.toThrow(
      "check-run cleanup remains incomplete: ambiguous gate check-run postil:run:gate is not visible on GitHub",
    );

    expect(
      completions.map(({ id, conclusion }) => ({ id, conclusion })),
    ).toEqual([{ id: 11, conclusion: "neutral" }]);
  });
});
