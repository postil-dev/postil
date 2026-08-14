import { describe, expect, test } from "bun:test";

import type { Database } from "@/lib/db";
import { schema } from "@/lib/db";
import type { Envelope } from "@/lib/envelope";
import { persistReviewCompletionWithGateMode } from "@/lib/review-completion";

function fakeDb(reviewUpdated = true): {
  db: Database;
  inserted: Array<{ table: unknown; values: unknown }>;
  updates: Array<Record<string, unknown>>;
  transactions: number;
} {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const updates: Array<Record<string, unknown>> = [];
  let transactions = 0;
  const tx = {
    execute() {
      return Promise.resolve();
    },
    select() {
      const chain = {
        from() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return Promise.resolve([{ githubRepoId: 21, repositoryId: 2, prNumber: 1 }]);
        },
      };
      return chain;
    },
    update() {
      const chain = {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve(
            reviewUpdated
              ? [{ id: 7, publicId: "review-public-id", triggerSource: "requested_review" }]
              : [],
          );
        },
      };
      return chain;
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          inserted.push({ table, values });
          return Promise.resolve();
        },
      };
    },
  };
  const db = {
    transaction<T>(callback: (transaction: typeof tx) => Promise<T>) {
      transactions += 1;
      return callback(tx);
    },
  } as unknown as Database;
  return {
    db,
    inserted,
    updates,
    get transactions() {
      return transactions;
    },
  };
}

const envelope = {
  version: 1,
  summary: "",
  silent: true,
  findings: [],
  resolved: [],
  counts: { info: 0, warn: 0, error: 0, suppressed: 0, ungrounded: 0 },
  confidenceBuckets: [0, 0, 0, 0, 0],
  gate: { failOn: "error", failing: false },
  modelUsed: "test/model",
  usage: { promptTokens: 0, completionTokens: 0 },
  durationMs: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  sinceSha: null,
} as Envelope;
const base = {
  reviewId: 7,
  envelope,
  configFiles: [],
  configProvenance: { entries: [], degraded: false },
  silent: false,
  gateFailing: false,
  usageAccountingComplete: true,
  usage: [
    {
      orgId: 1,
      repositoryId: 2,
      promptTokens: 100,
      completionTokens: 20,
      modelUsed: "generator",
      costMicros: 800,
      billingScope: "private_hosted" as const,
    },
    {
      orgId: 1,
      repositoryId: 2,
      promptTokens: 30,
      completionTokens: 10,
      modelUsed: "scorer",
      costMicros: 200,
      billingScope: "private_hosted" as const,
    },
  ],
};

describe("review completion transaction", () => {
  test("atomically records review usage and schedules gate reconciliation", async () => {
    const state = fakeDb();
    const completed = (await persistReviewCompletionWithGateMode(state.db, base, null)).completed;

    expect(completed).toBe(true);
    expect(state.transactions).toBe(1);
    expect(state.inserted.filter((row) => row.table === schema.usageEvents)).toHaveLength(1);
    const usageInsert = state.inserted.find((row) => row.table === schema.usageEvents);
    expect(usageInsert?.values).toEqual([
      { ...base.usage[0], reviewId: 7, triggerSource: "requested_review" },
      { ...base.usage[1], reviewId: 7, triggerSource: "requested_review" },
    ]);
    expect(state.inserted.filter((row) => row.table === schema.jobs)).toHaveLength(1);
  });

  test("records repeated model usage rows as separate events", async () => {
    const state = fakeDb();
    const sameModelUsage = base.usage.map((usage) => ({
      ...usage,
      modelUsed: "shared-model",
    }));

    expect(
      await persistReviewCompletionWithGateMode(
        state.db,
        { ...base, usage: sameModelUsage },
        null,
      ),
    ).toMatchObject({ completed: true });
    const usageInsert = state.inserted.find((row) => row.table === schema.usageEvents);
    expect(usageInsert?.values).toEqual([
      { ...sameModelUsage[0], reviewId: 7, triggerSource: "requested_review" },
      { ...sameModelUsage[1], reviewId: 7, triggerSource: "requested_review" },
    ]);
  });

  test("records no accounting after losing the completion race", async () => {
    const state = fakeDb(false);
    expect(
      await persistReviewCompletionWithGateMode(state.db, base, null),
    ).toMatchObject({ completed: false });
    expect(state.inserted).toEqual([]);
  });

  test("never persists an all-operational envelope as completed", async () => {
    const state = fakeDb();
    const operationalEnvelope: Envelope = {
      ...envelope,
      silent: false,
      findings: [
        {
          path: ".postil/provider",
          line: 1,
          severity: "error",
          kind: "uncertainty",
          confidence: 1,
          title: "Review provider unavailable",
          body: "The review provider did not return a usable result.",
        },
      ],
      counts: {
        info: 0,
        warn: 0,
        error: 1,
        suppressed: 0,
        ungrounded: 0,
      },
      confidenceBuckets: [0, 0, 0, 0, 1],
      gate: { failOn: "error", failing: true },
    };

    expect(
      await persistReviewCompletionWithGateMode(
        state.db,
        {
          ...base,
          envelope: operationalEnvelope,
          gateFailing: true,
          terminalStatus: "completed",
        },
        null,
      ),
    ).toMatchObject({ completed: true, gateFailing: false });
    expect(state.updates[0]).toMatchObject({
      status: "failed",
      errorMessage: "Review execution did not produce a reviewer verdict.",
      gateFailing: false,
    });
  });

  test("rejects a completion whose claimed gate contradicts its envelope", async () => {
    const state = fakeDb();
    await expect(
      persistReviewCompletionWithGateMode(
        state.db,
        { ...base, gateFailing: true },
        1,
      ),
    ).rejects.toThrow("gate truth does not match its envelope");
    expect(state.inserted).toEqual([]);
  });
});
