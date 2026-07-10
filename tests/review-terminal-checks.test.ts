import { beforeEach, describe, expect, mock, test } from "bun:test";

const realDb = await import("@/lib/db");
const realChecks = await import("@/lib/github/checks");

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

mock.module("@/lib/github/checks", () => ({
  ...realChecks,
  completeCheckRun: async (
    _token: string,
    _repo: string,
    id: number,
    conclusion: string,
    title: string,
    summary: string,
  ) => {
    completions.push({ id, conclusion, title, summary });
  },
}));

const { failCheckRuns, supersedeActiveReviews } = await import("@/worker/review");

beforeEach(() => {
  transitions.length = 0;
  completions.length = 0;
});

describe("review terminal check-runs", () => {
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
  });
});
