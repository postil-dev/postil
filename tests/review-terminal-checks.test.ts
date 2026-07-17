import { beforeEach, describe, expect, mock, test } from "bun:test";

const realDb = await import("@/lib/db");
const realChecks = await import("@/lib/github/checks");
const realAppAuth = await import("@/lib/github/app-auth");

const activeReviews = [
  { id: 10, advisoryCheckRunId: 11, gateCheckRunId: 22 },
];
const transitions: Array<Record<string, unknown>> = [];
const completions: Array<{
  id: number;
  conclusion: string;
  title: string;
  summary: string;
}> = [];
const failingCompletionIds = new Set<number>();
let reconciledCheckRunId: number | null = null;

function fakeDb() {
  return {
    select() {
      const chain = {
        from() {
          return chain;
        },
        where() {
          return Promise.resolve(activeReviews);
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
  };
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
  ) => {
    if (failingCompletionIds.has(id)) throw new Error(`check-run ${id} unavailable`);
    completions.push({ id, conclusion, title, summary });
  },
}));

const {
  completeHostedInferenceDisabledCheckRuns,
  failCheckRuns,
  runCheckRunCleanupJob,
  supersedeActiveReviews,
} = await import("@/worker/review");

beforeEach(() => {
  transitions.length = 0;
  completions.length = 0;
  failingCompletionIds.clear();
  reconciledCheckRunId = null;
});

describe("review terminal check-runs", () => {
  test("disabled hosted inference leaves both checks neutral without provider detail", async () => {
    await completeHostedInferenceDisabledCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
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
      ),
    ).rejects.toThrow("could not neutralize unavailable review check-runs");
    expect(completions.map(({ id, conclusion }) => ({ id, conclusion }))).toEqual([
      { id: 22, conclusion: "neutral" },
    ]);
  });

  test("superseded reviews neutralize both checks with the replacement head", async () => {
    const count = await supersedeActiveReviews({
      repositoryId: 5,
      prNumber: 313,
      newHeadSha: "new-head-sha",
      repoFullName: "postil-dev/postil",
      token: "test-token",
    });

    expect(count).toBe(1);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).toBe("stale");
    expect(completions).toEqual([
      {
        id: 22,
        conclusion: "neutral",
        title: "Review superseded",
        summary: "superseded by a newer review of new-head-sha",
      },
      {
        id: 11,
        conclusion: "neutral",
        title: "Review superseded",
        summary: "superseded by a newer review of new-head-sha",
      },
    ]);
  });

  test("operational failure fails the gate and neutralizes the advisory check", async () => {
    await failCheckRuns(
      "test-token",
      "postil-dev/postil",
      11,
      22,
      "worker stopped",
    );

    expect(completions.map(({ id, conclusion }) => ({ id, conclusion }))).toEqual([
      { id: 22, conclusion: "failure" },
      { id: 11, conclusion: "neutral" },
    ]);
    expect(completions.every(({ summary }) => !summary.includes("worker stopped"))).toBe(true);
    expect(completions[0]?.summary).toContain("no review verdict exists");
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
    );

    expect(completions.every(({ summary }) => !summary.includes("provider secret detail"))).toBe(true);
    expect(completions[0]?.summary).toContain(
      "[Review details](https://postil.dev/orgs/postil-dev/runs/run-id)",
    );
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
      ),
    ).rejects.toThrow("could not complete failed review check-runs");
    expect(completions.map(({ id }) => id)).toEqual([11]);
  });

  test("cleanup completes known checks before retrying an unresolved ambiguous peer", async () => {
    await expect(
      runCheckRunCleanupJob({
        installationId: 42,
        repoFullName: "postil-dev/postil",
        advisoryCheckRunId: 11,
        gateCheckRunId: null,
        headSha: "head-sha",
        gateCheckExternalId: "postil:run:gate",
        gateCheckRunMayExist: true,
        message: "worker stopped",
      }),
    ).rejects.toThrow("check-run cleanup remains incomplete");

    expect(completions.map(({ id, conclusion }) => ({ id, conclusion }))).toEqual([
      { id: 11, conclusion: "neutral" },
    ]);
  });
});
